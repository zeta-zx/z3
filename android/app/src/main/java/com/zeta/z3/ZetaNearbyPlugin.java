package com.zeta.z3;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashSet;

@CapacitorPlugin(name = "ZetaNearby")
public class ZetaNearbyPlugin extends Plugin {
    private static final int MAX_PACKET = 16_384;
    private static final int DISCOVERY_PORT = 42534;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ArrayDeque<String> packets = new ArrayDeque<>();
    private DatagramSocket listener;
    private DatagramSocket discovery;

    private static boolean isTailscale(InetAddress address) {
        if (!(address instanceof Inet4Address)) return false;
        byte[] raw = address.getAddress();
        int first = raw[0] & 0xff;
        int second = raw[1] & 0xff;
        return first == 100 && second >= 64 && second <= 127;
    }

    private static boolean isNearby(InetAddress address) {
        return address instanceof Inet4Address &&
            (address.isSiteLocalAddress() || address.isLinkLocalAddress() || isTailscale(address));
    }

    @PluginMethod public synchronized void listen(PluginCall call) {
        stopListener();
        try {
            var addresses = new LinkedHashSet<String>();
            var interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                var network = interfaces.nextElement();
                if (!network.isUp()) continue;
                var ips = network.getInetAddresses();
                while (ips.hasMoreElements() && addresses.size() < 12) {
                    var address = ips.nextElement();
                    if (isNearby(address)) addresses.add(address.getHostAddress());
                }
            }
            if (addresses.isEmpty()) {
                call.reject("Connect this device to a local network or Tailscale to pair.");
                return;
            }
            var socket = new DatagramSocket();
            listener = socket;
            new Thread(() -> receivePackets(socket), "zeta-nearby").start();

            try {
                var disc = new DatagramSocket(null);
                disc.setReuseAddress(true);
                disc.setBroadcast(true);
                disc.bind(new InetSocketAddress(DISCOVERY_PORT));
                discovery = disc;
                new Thread(() -> receivePackets(disc), "zeta-nearby-disc").start();
            } catch (IOException ignored) {
                /* Discovery port unavailable; direct UDP still works. */
            }

            handler.postDelayed(() -> {
                synchronized (this) {
                    if (listener == socket) stopListener();
                }
            }, 120_000);
            var result = new JSObject();
            result.put("addresses", new JSArray(addresses));
            result.put("port", socket.getLocalPort());
            call.resolve(result);
        } catch (IOException error) {
            call.reject("Could not listen for nearby Zeta devices.", error);
        }
    }

    private void receivePackets(DatagramSocket socket) {
        byte[] bytes = new byte[MAX_PACKET + 1];
        try {
            while (!socket.isClosed()) {
                var packet = new DatagramPacket(bytes, bytes.length);
                socket.receive(packet);
                if (packet.getLength() > MAX_PACKET || !isNearby(packet.getAddress())) continue;
                synchronized (this) {
                    if ((listener == socket || discovery == socket) && packets.size() < 32) {
                        packets.add(new String(bytes, 0, packet.getLength(), StandardCharsets.US_ASCII));
                    }
                }
            }
        } catch (IOException error) {
            synchronized (this) {
                if (listener == socket) stopListener();
            }
        }
    }

    @PluginMethod public synchronized void receive(PluginCall call) {
        var result = new JSObject();
        result.put("packets", new JSArray(packets));
        packets.clear();
        call.resolve(result);
    }

    @PluginMethod public synchronized void close(PluginCall call) {
        stopListener();
        call.resolve();
    }

    private synchronized void stopListener() {
        if (listener != null) listener.close();
        if (discovery != null) discovery.close();
        listener = null;
        discovery = null;
        packets.clear();
        handler.removeCallbacksAndMessages(null);
    }

    @PluginMethod public void send(PluginCall call) {
        var addresses = call.getArray("addresses");
        int port = call.getInt("port", 0);
        String packet = call.getString("packet", "");
        boolean isDiscovery = port == DISCOVERY_PORT;
        if ((!isDiscovery && (addresses == null || addresses.length() < 1 || addresses.length() > 12)) ||
            port < 1024 || port > 65535 || packet.length() > MAX_PACKET || !packet.matches("[A-Za-z0-9_.:,-]+")) {
            call.reject("Invalid nearby pairing destination.");
            return;
        }
        try (var socket = new DatagramSocket()) {
            if (isDiscovery) socket.setBroadcast(true);
            byte[] bytes = packet.getBytes(StandardCharsets.US_ASCII);
            IOException failure = null;
            boolean sent = false;
            var targets = new LinkedHashSet<InetAddress>();
            if (addresses != null) {
                for (int index = 0; index < addresses.length(); index++) {
                    String ip = addresses.optString(index);
                    if (!ip.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) {
                        if (!isDiscovery) {
                            call.reject("Invalid nearby pairing address.");
                            return;
                        }
                        continue;
                    }
                    var address = InetAddress.getByName(ip);
                    if (!isNearby(address) && !isDiscovery) {
                        call.reject("Invalid nearby pairing address.");
                        return;
                    }
                    targets.add(address);
                }
            }
            if (isDiscovery) {
                targets.add(InetAddress.getByName("255.255.255.255"));
                var interfaces = NetworkInterface.getNetworkInterfaces();
                while (interfaces != null && interfaces.hasMoreElements()) {
                    var network = interfaces.nextElement();
                    if (!network.isUp() || network.isLoopback()) continue;
                    for (InterfaceAddress ia : network.getInterfaceAddresses()) {
                        InetAddress broadcast = ia.getBroadcast();
                        if (broadcast instanceof Inet4Address) targets.add(broadcast);
                    }
                }
            }
            for (InetAddress address : targets) {
                try {
                    socket.send(new DatagramPacket(bytes, bytes.length, address, port));
                    sent = true;
                } catch (IOException error) {
                    failure = error;
                }
            }
            if (!sent && failure != null) throw failure;
            call.resolve();
        } catch (IOException error) {
            call.reject("Could not reach the other Zeta device.", error);
        }
    }

    @Override protected void handleOnDestroy() { stopListener(); }
}

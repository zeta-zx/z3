package com.zeta.z3;

import android.content.ComponentName;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.SettableFuture;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

@CapacitorPlugin(name = "ZetaPlayer")
public class ZetaPlayerPlugin extends Plugin {
    private static volatile ZetaPlayerPlugin onlineBridge;
    private static final AtomicReference<String> pendingWidgetCommand = new AtomicReference<>();
    private final ConcurrentHashMap<String, SettableFuture<String>> onlineRequests = new ConcurrentHashMap<>();
    private ListenableFuture<MediaController> connecting;
    private MediaController controller;
    private String playbackRevision = "";
    private volatile boolean onlineBridgeReady;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            emitState();
            handler.postDelayed(this, 500);
        }
    };

    @Override
    public void load() {
        onlineBridge = this;
        getActivity().runOnUiThread(() -> {
            SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
            connecting = new MediaController.Builder(getContext(), token).buildAsync();
            connecting.addListener(() -> {
                try {
                    controller = connecting.get();
                    controller.addListener(new Player.Listener() {
                        @Override public void onEvents(Player player, Player.Events events) { emitState(); }
                        @Override public void onPlayerError(PlaybackException error) {
                            JSObject value = new JSObject();
                            android.util.Log.e("ZetaPlayback", "Playback failed (" + error.getErrorCodeName() + ")", error);
                            value.put("message", error.getMessage() + " (" + error.getErrorCodeName() + ")");
                            value.put("id", controller.getCurrentMediaItem() == null ? "" : controller.getCurrentMediaItem().mediaId);
                            notifyListeners("playbackError", value);
                        }
                    });
                    handler.post(ticker);
                } catch (Exception error) {
                    JSObject value = new JSObject();
                    value.put("message", "Could not connect to Android playback: " + error.getMessage());
                    notifyListeners("playbackError", value, true);
                }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    static boolean widgetNavigation(String command) {
        ZetaPlayerPlugin plugin = onlineBridge;
        if (plugin == null || !plugin.hasListeners("widgetCommand")) return false;
        plugin.emitWidgetCommand(command);
        return true;
    }

    static void queueWidgetCommand(String command) {
        String action = "toggle".equals(command) ? "resume" : command;
        ZetaPlayerPlugin plugin = onlineBridge;
        if (plugin != null && plugin.hasListeners("widgetCommand")) plugin.emitWidgetCommand(action);
        else pendingWidgetCommand.set(action);
    }

    @PluginMethod public void takeWidgetCommand(PluginCall call) {
        String command = pendingWidgetCommand.getAndSet(null);
        var result = new JSObject();
        if (command != null) result.put("command", command);
        call.resolve(result);
    }

    private void emitWidgetCommand(String command) {
        var data = new JSObject();
        data.put("command", command);
        notifyListeners("widgetCommand", data);
    }

    static ListenableFuture<String> requestOnline(String event, JSObject payload) {
        ZetaPlayerPlugin bridge = onlineBridge;
        if (bridge == null || !bridge.onlineBridgeReady) {
            return Futures.immediateFailedFuture(
                new IllegalStateException("Open Zeta on your phone to use online Android Auto search and playback."));
        }

        String requestId = UUID.randomUUID().toString();
        SettableFuture<String> result = SettableFuture.create();
        bridge.onlineRequests.put(requestId, result);
        payload.put("requestId", requestId);
        bridge.handler.post(() -> {
            if (!result.isDone()) bridge.notifyListeners(event, payload, true);
        });
        bridge.handler.postDelayed(() -> {
            if (bridge.onlineRequests.remove(requestId, result)) {
                result.setException(new TimeoutException("The online music request timed out."));
            }
        }, 45_000);
        return result;
    }

    @PluginMethod
    public void setOnlineBridgeReady(PluginCall call) {
        onlineBridgeReady = call.getBoolean("ready", false);
        call.resolve();
    }

    @PluginMethod
    public void completeOnlineRequest(PluginCall call) {
        completeOnlineRequest(call, null);
    }

    @PluginMethod
    public void failOnlineRequest(PluginCall call) {
        completeOnlineRequest(call, call.getString("error", "The online music request failed."));
    }

    private void completeOnlineRequest(PluginCall call, String error) {
        String requestId = call.getString("requestId");
        SettableFuture<String> result = requestId == null ? null : onlineRequests.remove(requestId);
        if (result == null) {
            call.reject("The Android Auto request has expired.");
            return;
        }
        if (error != null) {
            result.setException(new IllegalStateException(error));
        } else {
            String response = call.getString("result");
            if (response == null) {
                result.setException(new IllegalArgumentException("The online music response was empty."));
            } else {
                result.set(response);
            }
        }
        call.resolve();
    }

    private void run(PluginCall call, Consumer<MediaController> action) {
        getActivity().runOnUiThread(() -> {
            if (connecting == null) { call.reject("Android playback is starting. Try again."); return; }
            connecting.addListener(() -> {
                try { action.accept(connecting.get()); call.resolve(); }
                catch (Exception error) { call.reject("Android playback failed: " + error.getMessage(), error); }
            }, ContextCompat.getMainExecutor(getContext()));
        });
    }

    @PluginMethod
    public void setSource(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || !uri.startsWith("file://")) { call.reject("Choose a local audio file."); return; }
        run(call, player -> {
            MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(call.getString("title", "Zeta"))
                .setArtist(call.getString("artist", ""));
            String artwork = call.getString("artwork");
            if (artwork != null && artwork.startsWith("https://")) metadata.setArtworkUri(Uri.parse(artwork));
            MediaItem item = new MediaItem.Builder().setUri(uri).setMediaId(call.getString("id", uri))
                .setMediaMetadata(metadata.build()).build();
            player.setMediaItem(item, (long) (call.getDouble("position", 0.0) * 1000));
            player.setPlayWhenReady(!call.getBoolean("paused", true));
            player.prepare();
            acknowledgePlayback(call);
        });
    }

    @PluginMethod public void setPaused(PluginCall call) {
        run(call, player -> {
            player.setPlayWhenReady(!call.getBoolean("paused", true));
            acknowledgePlayback(call);
        });
    }

    private void acknowledgePlayback(PluginCall call) {
        playbackRevision = call.getString("revision", playbackRevision);
        emitState();
    }
    @PluginMethod public void seek(PluginCall call) {
        run(call, player -> player.seekTo((long) (Math.max(0, call.getDouble("position", 0.0)) * 1000)));
    }
    @PluginMethod public void setAudioEffects(PluginCall call) {
        run(call, player -> {
            PlaybackService service = PlaybackService.active;
            if (service != null) {
                var values = call.getArray("bands");
                double[] bands = new double[5];
                for (int index = 0; index < bands.length; index++) {
                    double value = values == null ? 0 : values.optDouble(index, 0);
                    bands[index] = Double.isFinite(value) ? Math.max(-6, Math.min(6, value)) : 0;
                }
                service.setAudioEffects(bands, call.getBoolean("leveling", false));
            }
        });
    }

    @PluginMethod public void setVolume(PluginCall call) {
        run(call, player -> player.setVolume((float) Math.max(0, Math.min(1, call.getDouble("volume", 1.0)))));
    }
    @PluginMethod public void clear(PluginCall call) {
        run(call, player -> { player.stop(); player.clearMediaItems(); });
    }
    @PluginMethod public void setKeepAwake(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (call.getBoolean("enabled", false)) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod public void setWidgetTheme(PluginCall call) {
        String theme = "material".equals(call.getString("theme")) ? "material" : "artwork";
        ZetaPlaybackWidget.setTheme(getContext(), theme);
        PlaybackService service = PlaybackService.active;
        if (service != null) service.updateWidget();
        else ZetaPlaybackWidget.refresh(getContext(), null);
        call.resolve();
    }

    private void emitState() {
        if (controller == null || controller.getCurrentMediaItem() == null) return;
        JSObject state = new JSObject();
        state.put("id", controller.getCurrentMediaItem().mediaId);
        state.put("position", controller.getCurrentPosition() / 1000.0);
        state.put("duration", Math.max(0, controller.getDuration()) / 1000.0);
        state.put("paused", !controller.getPlayWhenReady());
        state.put("revision", playbackRevision);
        state.put("ready", controller.getPlaybackState() == Player.STATE_READY);
        state.put("ended", controller.getPlaybackState() == Player.STATE_ENDED);
        notifyListeners("state", state);
    }

    @Override
    protected void handleOnDestroy() {
        onlineBridgeReady = false;
        if (onlineBridge == this) onlineBridge = null;
        for (SettableFuture<String> request : onlineRequests.values()) {
            request.setException(new IllegalStateException("The Zeta app was closed during the online music request."));
        }
        onlineRequests.clear();
        handler.removeCallbacks(ticker);
        if (connecting != null) MediaController.releaseFuture(connecting);
        controller = null;
    }
}

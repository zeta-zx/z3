package com.zeta.z3;

import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "ZetaMediaDownload")
public class ZetaMediaDownloadPlugin extends Plugin {
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private static final int CHUNK = 1024 * 1024;

    private final java.util.concurrent.ExecutorService downloads = java.util.concurrent.Executors.newFixedThreadPool(2);

    @Override protected void handleOnDestroy() {
        downloads.shutdown();
    }

    @PluginMethod public void download(PluginCall call) {
        downloads.execute(() -> {
            File destination = null;
            try {
                URL url = new URL(call.getString("url", ""));
                String host = url.getHost();
                if (!"https".equals(url.getProtocol()) || !host.endsWith(".googlevideo.com")
                        || !"/videoplayback".equals(url.getPath()) || url.getRef() != null
                        || (url.getPort() != -1 && url.getPort() != 443) || url.getUserInfo() != null) {
                    throw new IOException("Invalid YouTube media URL.");
                }
                Uri uri = Uri.parse(call.getString("path", ""));
                if (!"file".equals(uri.getScheme()) || uri.getPath() == null) throw new IOException("Invalid temporary file.");
                File file = new File(uri.getPath()).getCanonicalFile();
                File parent = file.getParentFile();
                File data = new File(getContext().getFilesDir(), "zeta/audio").getCanonicalFile();
                File cache = new File(getContext().getCacheDir(), "zeta/audio").getCanonicalFile();
                if ((!data.equals(parent) && !cache.equals(parent)) || !file.getName().endsWith(".part")) {
                    throw new IOException("Invalid temporary file.");
                }
                int length = call.getInt("size", 0);
                if (length <= 0 || length > MAX_BYTES) throw new IOException("Invalid YouTube audio size.");
                destination = file;
                try (FileOutputStream output = new FileOutputStream(destination)) {
                    for (int offset = 0; offset < length; offset += CHUNK) {
                        int bytes = Math.min(CHUNK, length - offset);
                        copyRange(url, offset, bytes, output);
                    }
                }
                call.resolve();
            } catch (Exception error) {
                if (destination != null) destination.delete();
                call.reject(error.getMessage(), error);
            }
        });
    }

    private void copyRange(URL base, int offset, int bytes, FileOutputStream output) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) base.openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(8000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Range", "bytes=" + offset + "-" + (offset + bytes - 1));
        try {
            int status = connection.getResponseCode();
            if (status != 200 && status != 206) throw new IOException("YouTube media returned HTTP " + status + ".");
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[64 * 1024];
                int remaining = bytes;
                while (remaining > 0) {
                    int read = input.read(buffer, 0, Math.min(buffer.length, remaining));
                    if (read < 0) throw new IOException("YouTube returned an incomplete audio range.");
                    output.write(buffer, 0, read);
                    remaining -= read;
                }
                if (input.read() != -1) throw new IOException("YouTube did not honor the requested audio range.");
            }
        } finally {
            connection.disconnect();
        }
    }
}

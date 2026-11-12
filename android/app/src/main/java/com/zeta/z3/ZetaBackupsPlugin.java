package com.zeta.z3;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "ZetaBackups")
public class ZetaBackupsPlugin extends Plugin {
    private static final long MAX_BYTES = 512L * 1024 * 1024;

    private File cacheFile(PluginCall call) {
        String key = call.getString("key", "");
        if (!key.matches("[0-9a-f-]{36}")) throw new IllegalArgumentException("Invalid backup request.");
        return new File(getContext().getCacheDir(), "backups/" + key);
    }

    @PluginMethod
    public void pickBackup(PluginCall call) {
        cacheFile(call);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "backupPicked");
    }

    @PluginMethod
    public void saveBackup(PluginCall call) {
        File source = cacheFile(call);
        if (!source.isFile() || source.length() > MAX_BYTES) {
            call.reject("The backup is missing or too large.");
            return;
        }
        String suffix = call.getBoolean("muzza", false) ? ".backup" : ".zetabackup";
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        String date = new java.text.SimpleDateFormat("yyyy-MM-dd_HHmmss", java.util.Locale.ROOT).format(new java.util.Date());
        intent.putExtra(Intent.EXTRA_TITLE, "Zeta_" + date + suffix);
        startActivityForResult(call, intent, "backupSaved");
    }

    @ActivityCallback
    private void backupPicked(PluginCall call, ActivityResult result) {
        transfer(call, result, false);
    }

    @ActivityCallback
    private void backupSaved(PluginCall call, ActivityResult result) {
        transfer(call, result, true);
    }

    private void transfer(PluginCall call, ActivityResult result, boolean saving) {
        if (call == null) return;
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null
            ? result.getData().getData() : null;
        if (uri == null) {
            complete(call, false);
            return;
        }
        bridge.execute(() -> {
            File file = cacheFile(call);
            try {
                if (!saving && !file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) {
                    throw new IOException("Could not create backup cache.");
                }
                try (
                    InputStream input = saving ? new FileInputStream(file) : getContext().getContentResolver().openInputStream(uri);
                    OutputStream output = saving ? getContext().getContentResolver().openOutputStream(uri, "wt") : new FileOutputStream(file)
                ) {
                    if (input == null || output == null) throw new IOException("Could not open backup file.");
                    byte[] bytes = new byte[64 * 1024];
                    long size = 0;
                    int count;
                    while ((count = input.read(bytes)) != -1) {
                        size += count;
                        if (size > MAX_BYTES) throw new IOException("The backup exceeds 512 MiB.");
                        output.write(bytes, 0, count);
                    }
                }
                complete(call, true);
            } catch (Exception error) {
                call.reject("Could not " + (saving ? "save" : "read") + " backup: " + error.getMessage(), error);
            }
        });
    }

    private void complete(PluginCall call, boolean selected) {
        JSObject response = new JSObject();
        response.put("selected", selected);
        call.resolve(response);
    }
}

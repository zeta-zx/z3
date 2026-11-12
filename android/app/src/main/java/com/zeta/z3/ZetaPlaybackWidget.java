package com.zeta.z3;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;
import androidx.media3.common.Player;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ZetaPlaybackWidget extends AppWidgetProvider {
    private static final String CONTROL = "com.zeta.z3.WIDGET_CONTROL";
    private static final String PREFS = "zeta_widget";
    private static final String KEY_THEME = "theme";
    private static final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    private static volatile String cachedArtUri = "";
    private static volatile Bitmap cachedArtBitmap;
    private static volatile int cachedBgColor = 0xFF171222;
    private static volatile int cachedAccentColor = 0xFFD1C5DF;

    static void setTheme(Context context, String theme) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_THEME, "material".equals(theme) ? "material" : "artwork")
            .apply();
    }

    private static String getTheme(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_THEME, "artwork");
    }

    private static void extractArtworkColors(Bitmap bitmap) {
        if (bitmap == null) {
            cachedBgColor = 0xFF171222;
            cachedAccentColor = 0xFFD1C5DF;
            return;
        }
        Bitmap sample = Bitmap.createScaledBitmap(bitmap, 16, 16, true);
        double rBg = 0, gBg = 0, bBg = 0, wBg = 0;
        double rAc = 0, gAc = 0, bAc = 0, wAc = 0;
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                int pixel = sample.getPixel(x, y);
                int r = Color.red(pixel), g = Color.green(pixel), b = Color.blue(pixel);
                float[] hsv = new float[3];
                Color.RGBToHSV(r, g, b, hsv);
                double w1 = 0.2 + hsv[1] * 1.4;
                rBg += r * w1; gBg += g * w1; bBg += b * w1; wBg += w1;
                double w2 = 0.1 + hsv[1] * 2.2 + (1.0 - Math.abs(hsv[2] - 0.65)) * 0.8;
                rAc += r * w2; gAc += g * w2; bAc += b * w2; wAc += w2;
            }
        }
        if (wBg > 0) {
            float[] hsv = new float[3];
            Color.RGBToHSV((int) (rBg / wBg), (int) (gBg / wBg), (int) (bBg / wBg), hsv);
            hsv[1] = Math.min(0.68f, hsv[1] * 1.15f);
            hsv[2] = Math.max(0.14f, Math.min(0.28f, hsv[2] * 0.42f));
            cachedBgColor = Color.HSVToColor(hsv);
        }
        if (wAc > 0) {
            float[] hsv = new float[3];
            Color.RGBToHSV((int) (rAc / wAc), (int) (gAc / wAc), (int) (bAc / wAc), hsv);
            hsv[1] = Math.min(0.45f, hsv[1]);
            hsv[2] = Math.max(0.78f, Math.min(0.95f, hsv[2]));
            cachedAccentColor = Color.HSVToColor(hsv);
        }
    }

    private static void ensureArtworkLoaded(Context appContext, Uri artworkUri) {
        String target = artworkUri == null ? "" : artworkUri.toString();
        if (target.isEmpty()) {
            cachedArtUri = "";
            cachedArtBitmap = null;
            cachedBgColor = 0xFF171222;
            cachedAccentColor = 0xFFD1C5DF;
            return;
        }
        if (target.equals(cachedArtUri)) return;
        cachedArtUri = target;
        artworkExecutor.execute(() -> {
            Bitmap decoded = null;
            try {
                if ("https".equalsIgnoreCase(artworkUri.getScheme())) {
                    HttpURLConnection conn = (HttpURLConnection) new URL(target).openConnection();
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);
                    try (InputStream in = conn.getInputStream()) {
                        decoded = BitmapFactory.decodeStream(in);
                    } finally {
                        conn.disconnect();
                    }
                } else if ("file".equalsIgnoreCase(artworkUri.getScheme()) && artworkUri.getPath() != null) {
                    decoded = BitmapFactory.decodeFile(artworkUri.getPath());
                } else {
                    try (InputStream in = appContext.getContentResolver().openInputStream(artworkUri)) {
                        if (in != null) decoded = BitmapFactory.decodeStream(in);
                    }
                }
                if (decoded != null) {
                    int size = 128;
                    decoded = Bitmap.createScaledBitmap(decoded, size, size, true);
                }
            } catch (Exception ignored) {
                decoded = null;
            }
            if (!target.equals(cachedArtUri)) return;
            cachedArtBitmap = decoded;
            extractArtworkColors(decoded);
            if (PlaybackService.active != null) PlaybackService.active.updateWidget();
            else refresh(appContext, null);
        });
    }

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        if (PlaybackService.active != null) PlaybackService.active.updateWidget();
        else refresh(context, null);
    }

    @Override public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()) || CONTROL.equals(intent.getAction())) {
            if (CONTROL.equals(intent.getAction()) && PlaybackService.active != null) {
                PlaybackService.active.widgetAction(intent.getStringExtra("control"));
            }
            onUpdate(context, AppWidgetManager.getInstance(context), new int[0]);
        }
    }

    static void refresh(Context context, Player player) {
        var manager = AppWidgetManager.getInstance(context);
        var component = new ComponentName(context, ZetaPlaybackWidget.class);
        if (manager.getAppWidgetIds(component).length == 0) return;
        RemoteViews view = new RemoteViews(context.getPackageName(), R.layout.zeta_widget);
        var metadata = player == null ? null : player.getMediaMetadata();
        ensureArtworkLoaded(context.getApplicationContext(), metadata == null ? null : metadata.artworkUri);

        boolean useMaterialYou = "material".equals(getTheme(context)) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
        int bgColor = 0xFF171222;
        int titleColor = 0xFFFFFFFF;
        int artistColor = 0xFFD1C5DF;
        if (useMaterialYou) {
            bgColor = context.getColor(android.R.color.system_neutral1_900);
            titleColor = context.getColor(android.R.color.system_accent1_100);
            artistColor = context.getColor(android.R.color.system_neutral2_200);
        } else if (cachedArtBitmap != null) {
            bgColor = cachedBgColor;
            artistColor = cachedAccentColor;
        }

        view.setInt(R.id.widget_root, "setBackgroundColor", bgColor);
        view.setTextColor(R.id.widget_title, titleColor);
        view.setTextColor(R.id.widget_artist, artistColor);
        if (cachedArtBitmap != null) {
            view.setViewVisibility(R.id.widget_artwork, View.VISIBLE);
            view.setImageViewBitmap(R.id.widget_artwork, cachedArtBitmap);
        } else {
            view.setViewVisibility(R.id.widget_artwork, View.GONE);
        }

        view.setTextViewText(R.id.widget_title, metadata != null && metadata.title != null ? metadata.title : "Zeta");
        view.setTextViewText(R.id.widget_artist, metadata != null && metadata.artist != null ? metadata.artist : "Tap play to open Zeta");
        view.setImageViewResource(R.id.widget_toggle, player != null && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED
            ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        var open = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), flags);
        view.setOnClickPendingIntent(R.id.widget_title, open);
        view.setOnClickPendingIntent(R.id.widget_artist, open);
        view.setOnClickPendingIntent(R.id.widget_artwork, open);
        int[] buttons = { R.id.widget_previous, R.id.widget_toggle, R.id.widget_next };
        String[] actions = { "previous", "toggle", "next" };
        for (int index = 0; index < buttons.length; index++) {
            view.setInt(buttons[index], "setBackgroundColor", bgColor);
            view.setInt(buttons[index], "setColorFilter", titleColor);
            var intent = new Intent(context, ZetaWidgetActionActivity.class).putExtra("control", actions[index]);
            view.setOnClickPendingIntent(buttons[index], PendingIntent.getActivity(context, index + 1, intent, flags));
        }
        manager.updateAppWidget(component, view);
    }
}

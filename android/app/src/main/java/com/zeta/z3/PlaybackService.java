package com.zeta.z3;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.util.Base64;
import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionError;
import com.getcapacitor.JSObject;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.common.util.concurrent.MoreExecutors;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Owns playback and exposes downloaded music to Android Auto and system browsers. */
public class PlaybackService extends MediaLibraryService {
    private static final String TAG = "ZetaPlayback";
    private static final String ROOT_ID = "root";
    private static final String DOWNLOADS_ID = "downloads";
    private static final String PLAYLISTS_ID = "playlists";
    private static final String ALBUMS_ID = "albums";
    private static final String FAVOURITES_ID = "favourites.m3u8";
    private static final String PLAYLIST_PREFIX = "playlist:";
    private static final String ALBUM_PREFIX = "album:";
    private static final String SONG_PREFIX = "song:";
    private static final String ONLINE_PREFIX = "online:";

    private MediaLibrarySession session;
    static PlaybackService active;
    private final ZetaAudioLeveler leveler = new ZetaAudioLeveler();
    private android.media.audiofx.Equalizer equalizer;
    private int sessionId;
    private double[] bands = new double[5];
    private final ExecutorService libraryExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, List<MediaItem>> searchResults = new ConcurrentHashMap<>();
    private final MediaLibrarySession.Callback callback = new MediaLibrarySession.Callback() {
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, LibraryParams params) {
            return Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT_ID, "Zeta"), params));
        }

        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, String parentId,
                int page, int pageSize, LibraryParams params) {
            return Futures.submit(() -> {
                try {
                    ArrayList<MediaItem> children = getChildren(parentId);
                    long first = (long) page * pageSize;
                    if (first >= children.size()) {
                        return LibraryResult.ofItemList(ImmutableList.of(), params);
                    }
                    int start = (int) first;
                    int end = Math.min(start + pageSize, children.size());
                    return LibraryResult.ofItemList(ImmutableList.copyOf(children.subList(start, end)), params);
                } catch (Exception error) {
                    Log.e(TAG, "Could not read the offline library for Android Auto.", error);
                    return LibraryResult.ofError(SessionError.ERROR_IO);
                }
            }, libraryExecutor);
        }

        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, String mediaId) {
            return Futures.submit(() -> {
                try {
                    JSONObject stored = findStoredSong(mediaId);
                    MediaItem item = stored == null ? null : playableSong(stored);
                    if (item == null) item = findOnlineSong(mediaId);
                    return item == null
                        ? LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
                        : LibraryResult.ofItem(item, null);
                } catch (Exception error) {
                    Log.e(TAG, "Could not load an offline song for Android Auto.", error);
                    return LibraryResult.ofError(SessionError.ERROR_IO);
                }
            }, libraryExecutor);
        }

        @Override
        public ListenableFuture<LibraryResult<Void>> onSearch(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, String query, LibraryParams params) {
            ListenableFuture<LibraryResult<Void>> result = Futures.transform(
                searchOnline(query),
                songs -> LibraryResult.ofVoid(),
                MoreExecutors.directExecutor());
            return Futures.catching(result, Exception.class, error -> {
                Log.e(TAG, "Online Android Auto search failed.", error);
                return LibraryResult.ofError(SessionError.ERROR_IO);
            }, MoreExecutors.directExecutor());
        }

        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetSearchResult(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, String query,
                int page, int pageSize, LibraryParams params) {
            ListenableFuture<List<MediaItem>> results = searchResults.containsKey(query)
                ? Futures.immediateFuture(searchResults.get(query))
                : searchOnline(query);
            ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> result = Futures.transform(results, songs -> {
                long first = (long) page * pageSize;
                if (first >= songs.size()) return LibraryResult.ofItemList(ImmutableList.of(), params);
                int start = (int) first;
                int end = Math.min(start + pageSize, songs.size());
                return LibraryResult.ofItemList(ImmutableList.copyOf(songs.subList(start, end)), params);
            }, MoreExecutors.directExecutor());
            return Futures.catching(result, Exception.class, error -> {
                Log.e(TAG, "Could not load online Android Auto search results.", error);
                return LibraryResult.ofError(SessionError.ERROR_IO);
            }, MoreExecutors.directExecutor());
        }

        @Override
        @OptIn(markerClass = UnstableApi.class)
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onSetMediaItems(
                MediaSession session, MediaSession.ControllerInfo controller, List<MediaItem> mediaItems,
                int startIndex, long startPositionMs) {
            ArrayList<ListenableFuture<MediaItem>> resolved = new ArrayList<>();
            for (MediaItem item : mediaItems) {
                if (item.localConfiguration != null) {
                    resolved.add(Futures.immediateFuture(item));
                } else if (isOnlineMediaId(item.mediaId)) {
                    resolved.add(resolveOnlineSong(item));
                } else if (item.requestMetadata.searchQuery != null && !item.requestMetadata.searchQuery.trim().isEmpty()) {
                    resolved.add(resolveSearch(item.requestMetadata.searchQuery));
                } else {
                    resolved.add(Futures.immediateFailedFuture(
                        new IllegalArgumentException("The selected Android Auto item is not playable.")));
                }
            }
            return Futures.transform(
                Futures.allAsList(resolved),
                items -> new MediaSession.MediaItemsWithStartPosition(items, startIndex, startPositionMs),
                MoreExecutors.directExecutor());
        }
    };

    @Override
    @OptIn(markerClass = UnstableApi.class)
    public void onCreate() {
        super.onCreate();
        Map<String, String> requestHeaders = new HashMap<>();
        requestHeaders.put("Referer", "https://www.youtube.com/");
        var renderers = new androidx.media3.exoplayer.DefaultRenderersFactory(this) {
            @Override protected androidx.media3.exoplayer.audio.AudioSink buildAudioSink(
                    android.content.Context context, boolean enableFloatOutput, boolean enableAudioOutputPlaybackParams) {
                return new androidx.media3.exoplayer.audio.DefaultAudioSink.Builder(context)
                    .setAudioProcessors(new androidx.media3.common.audio.AudioProcessor[] { leveler })
                    .build();
            }
        };
        var httpFactory = new DefaultHttpDataSource.Factory()
            .setUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")
            .setDefaultRequestProperties(requestHeaders);
        ExoPlayer player = new ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, httpFactory)))
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();
        PendingIntent activity = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        session = new MediaLibrarySession.Builder(this, player, callback).setSessionActivity(activity).build();
        active = this;
        player.addListener(new androidx.media3.common.Player.Listener() {
            @Override public void onAudioSessionIdChanged(int id) {
                if (equalizer != null) { equalizer.release(); equalizer = null; }
                sessionId = id;
                applyEqualizer();
            }

            @Override public void onMediaMetadataChanged(MediaMetadata metadata) { updateWidget(); }
            @Override public void onPlayWhenReadyChanged(boolean playing, int reason) { updateWidget(); }
            @Override public void onPlaybackStateChanged(int state) { updateWidget(); }
            @Override public void onMediaItemTransition(MediaItem item, int reason) { updateWidget(); }
        });
        sessionId = player.getAudioSessionId();
        updateWidget();
    }

    void setAudioEffects(double[] values, boolean leveling) {
        bands = values;
        leveler.enabled = leveling;
        applyEqualizer();
    }

    private void applyEqualizer() {
        if (sessionId <= 0) return;
        boolean enabled = java.util.Arrays.stream(bands).anyMatch(value -> value != 0);
        try {
            if (enabled && equalizer == null) equalizer = new android.media.audiofx.Equalizer(0, sessionId);
            if (equalizer == null) return;
            int[] centers = { 60, 230, 910, 3600, 14000 };
            short[] range = equalizer.getBandLevelRange();
            for (short band = 0; band < equalizer.getNumberOfBands(); band++) {
                double center = equalizer.getCenterFreq(band) / 1000.0;
                int nearest = 0;
                for (int index = 1; index < centers.length; index++) {
                    if (Math.abs(Math.log(center / centers[index])) < Math.abs(Math.log(center / centers[nearest]))) nearest = index;
                }
                equalizer.setBandLevel(band, (short) Math.max(range[0], Math.min(range[1], bands[nearest] * 100)));
            }
            equalizer.setEnabled(enabled);
        } catch (RuntimeException error) {
            Log.w(TAG, "Device equalizer is unavailable.", error);
        }
    }

    void updateWidget() {
        ZetaPlaybackWidget.refresh(this, session == null ? null : session.getPlayer());
    }

    boolean widgetAction(String action) {
        if (session == null) return false;
        var player = session.getPlayer();
        if (player.getCurrentMediaItem() == null) return false;
        if ("toggle".equals(action)) {
            if (player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED) player.pause();
            else {
                if (player.getPlaybackState() == Player.STATE_ENDED) player.seekToDefaultPosition();
                if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
                player.play();
            }
        } else if ("previous".equals(action) || "next".equals(action)) {
            if (player.getMediaItemCount() <= 1) {
                if (ZetaPlayerPlugin.widgetNavigation(action)) return true;
                if ("next".equals(action)) return false;
            }
            if ("previous".equals(action)) player.seekToPrevious(); else player.seekToNext();
        } else return false;
        return true;
    }

    @Override
    public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controllerInfo) { return session; }

    @Override public void onTaskRemoved(Intent rootIntent) {
        // A widget tap briefly creates its own task. Finishing it is not a dismissal of the player.
        if (rootIntent != null && new ComponentName(this, ZetaWidgetActionActivity.class).equals(rootIntent.getComponent())) return;
        super.onTaskRemoved(rootIntent);
    }

    private ListenableFuture<MediaItem> resolveSearch(String query) {
        return Futures.transformAsync(searchOnline(query), songs -> {
            if (songs.isEmpty()) {
                return Futures.immediateFailedFuture(new IllegalArgumentException("No tracks match the search."));
            }
            return resolveOnlineSong(songs.get(0));
        }, MoreExecutors.directExecutor());
    }

    private ListenableFuture<MediaItem> resolveOnlineSong(MediaItem item) {
        JSObject request = new JSObject();
        request.put("mediaId", item.mediaId.substring(ONLINE_PREFIX.length()));
        return Futures.transform(
            ZetaPlayerPlugin.requestOnline("onlineResolve", request),
            response -> {
                JSONObject audio = parseObject(response);
                Uri uri = Uri.parse(audio.optString("url", ""));
                if (!"file".equals(uri.getScheme()) || uri.getPath() == null) {
                    throw new IllegalArgumentException("The provider returned an invalid audio file.");
                }
                try {
                    File file = new File(uri.getPath()).getCanonicalFile();
                    File data = new File(getFilesDir(), "zeta/audio").getCanonicalFile();
                    File cache = new File(getCacheDir(), "zeta/audio").getCanonicalFile();
                    if ((!data.equals(file.getParentFile()) && !cache.equals(file.getParentFile())) || !file.isFile()) {
                        throw new IllegalArgumentException("The audio file is unavailable.");
                    }
                } catch (java.io.IOException error) {
                    throw new IllegalArgumentException("Could not open the audio file.", error);
                }
                return item.buildUpon().setUri(uri).build();
            },
            MoreExecutors.directExecutor());
    }

    private ListenableFuture<List<MediaItem>> searchOnline(String query) {
        JSObject request = new JSObject();
        request.put("query", query);
        return Futures.transform(
            ZetaPlayerPlugin.requestOnline("onlineSearch", request),
            response -> {
                JSONArray songs = parseArray(response);
                ArrayList<MediaItem> items = new ArrayList<>();
                for (int i = 0; i < songs.length(); i++) {
                    JSONObject song = songs.optJSONObject(i);
                    MediaItem item = song == null ? null : onlineMediaItem(song);
                    if (item != null) items.add(item);
                }
                searchResults.put(query, items);
                while (searchResults.size() > 8) {
                    Iterator<String> queries = searchResults.keySet().iterator();
                    if (!queries.hasNext()) break;
                    searchResults.remove(queries.next());
                }
                return items;
            },
            MoreExecutors.directExecutor());
    }

    private MediaItem findOnlineSong(String mediaId) {
        for (List<MediaItem> items : searchResults.values()) {
            for (MediaItem item : items) {
                if (mediaId.equals(item.mediaId)) return item;
            }
        }
        return null;
    }

    private boolean isOnlineMediaId(String mediaId) {
        if (mediaId == null || !mediaId.startsWith(ONLINE_PREFIX)) return false;
        String sourceId = mediaId.substring(ONLINE_PREFIX.length());
        return (sourceId.startsWith("yt:") || sourceId.startsWith("js:"))
            && sourceId.length() > 3;
    }

    private MediaItem onlineMediaItem(JSONObject song) {
        String sourceId = song.optString("id", "");
        if (!(sourceId.startsWith("yt:") || sourceId.startsWith("js:")) || sourceId.length() <= 3) return null;
        JSONArray artists = song.optJSONArray("artists");
        StringBuilder artistNames = new StringBuilder();
        if (artists != null) {
            for (int i = 0; i < artists.length(); i++) {
                JSONObject artist = artists.optJSONObject(i);
                if (artist == null) continue;
                if (artistNames.length() > 0) artistNames.append(", ");
                artistNames.append(artist.optString("name", ""));
            }
        }
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(song.optString("title", "Unknown track"))
            .setArtist(artistNames.toString())
            .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
            .setIsBrowsable(false)
            .setIsPlayable(true);
        JSONObject album = song.optJSONObject("album");
        if (album != null) metadata.setAlbumTitle(album.optString("title", ""));
        JSONArray thumbnails = song.optJSONArray("thumbnails");
        if (thumbnails != null && thumbnails.length() > 0) {
            JSONObject thumbnail = thumbnails.optJSONObject(0);
            String artwork = thumbnail == null ? "" : thumbnail.optString("url", "");
            if (artwork.startsWith("https://")) metadata.setArtworkUri(Uri.parse(artwork));
        }
        return new MediaItem.Builder()
            .setMediaId(ONLINE_PREFIX + sourceId)
            .setMediaMetadata(metadata.build())
            .build();
    }

    private JSONObject parseObject(String value) {
        try {
            return new JSONObject(value);
        } catch (JSONException error) {
            throw new IllegalArgumentException("The online provider returned invalid playback data.", error);
        }
    }

    private JSONArray parseArray(String value) {
        try {
            return new JSONArray(value);
        } catch (JSONException error) {
            throw new IllegalArgumentException("The online provider returned invalid search data.", error);
        }
    }

    private ArrayList<MediaItem> getChildren(String parentId) throws Exception {
        JSONObject library = readLibrary();
        ArrayList<MediaItem> items = new ArrayList<>();
        if (ROOT_ID.equals(parentId)) {
            items.add(folder(DOWNLOADS_ID, "Downloads"));
            items.add(folder(FAVOURITES_ID, "Favourites"));
            items.add(folder(PLAYLISTS_ID, "Playlists"));
            items.add(folder(ALBUMS_ID, "Albums"));
            return items;
        }

        if (PLAYLISTS_ID.equals(parentId)) {
            JSONArray playlists = library.optJSONArray("playlists");
            if (playlists != null) {
                for (int i = 0; i < playlists.length(); i++) {
                    JSONObject playlist = playlists.optJSONObject(i);
                    if (playlist == null) continue;
                    String id = playlist.optString("id", "");
                    if (id.isEmpty() || FAVOURITES_ID.equals(id)) continue;
                    items.add(folder(PLAYLIST_PREFIX + id, playlist.optString("name", "Playlist")));
                }
            }
            items.sort(Comparator.comparing(item -> item.mediaMetadata.title == null ? "" : item.mediaMetadata.title.toString(), String.CASE_INSENSITIVE_ORDER));
            return items;
        }

        JSONObject songs = library.optJSONObject("songs");
        if (songs == null) return items;
        if (DOWNLOADS_ID.equals(parentId)) {
            Iterator<String> ids = songs.keys();
            while (ids.hasNext()) {
                JSONObject stored = songs.optJSONObject(ids.next());
                MediaItem item = stored == null ? null : playableSong(stored);
                if (item != null) items.add(item);
            }
            sortSongs(items);
            return items;
        }

        if (ALBUMS_ID.equals(parentId)) {
            java.util.LinkedHashMap<String, String> albums = new java.util.LinkedHashMap<>();
            Iterator<String> ids = songs.keys();
            while (ids.hasNext()) {
                JSONObject stored = songs.optJSONObject(ids.next());
                if (stored == null || stored.optString("file", "").isEmpty()) continue;
                JSONObject song = stored.optJSONObject("song");
                JSONObject album = song == null ? null : song.optJSONObject("album");
                String title = album == null ? "" : album.optString("title", "");
                if (!title.isEmpty()) albums.putIfAbsent(title, title);
            }
            for (String title : albums.values()) {
                String encoded = Base64.encodeToString(title.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                items.add(folder(ALBUM_PREFIX + encoded, title));
            }
            items.sort(Comparator.comparing(item -> item.mediaMetadata.title == null ? "" : item.mediaMetadata.title.toString(), String.CASE_INSENSITIVE_ORDER));
            return items;
        }

        if (parentId.startsWith(ALBUM_PREFIX)) {
            String encoded = parentId.substring(ALBUM_PREFIX.length());
            String albumTitle = new String(Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8);
            Iterator<String> ids = songs.keys();
            while (ids.hasNext()) {
                JSONObject stored = songs.optJSONObject(ids.next());
                if (stored == null || stored.optString("file", "").isEmpty()) continue;
                JSONObject song = stored.optJSONObject("song");
                JSONObject album = song == null ? null : song.optJSONObject("album");
                if (album != null && albumTitle.equals(album.optString("title", ""))) {
                    MediaItem item = playableSong(stored);
                    if (item != null) items.add(item);
                }
            }
            sortSongs(items);
            return items;
        }

        String playlistId = FAVOURITES_ID.equals(parentId)
            ? FAVOURITES_ID
            : parentId.startsWith(PLAYLIST_PREFIX) ? parentId.substring(PLAYLIST_PREFIX.length()) : null;
        if (playlistId == null) return items;
        JSONArray playlists = library.optJSONArray("playlists");
        if (playlists == null) return items;
        for (int i = 0; i < playlists.length(); i++) {
            JSONObject playlist = playlists.optJSONObject(i);
            if (playlist == null || !playlistId.equals(playlist.optString("id"))) continue;
            JSONArray tracks = playlist.optJSONArray("tracks");
            if (tracks == null) break;
            for (int j = 0; j < tracks.length(); j++) {
                JSONObject track = tracks.optJSONObject(j);
                if (track == null) continue;
                JSONObject stored = songs.optJSONObject(track.optString("id"));
                MediaItem item = stored == null ? null : playableSong(stored);
                if (item != null) items.add(item);
            }
            break;
        }
        return items;
    }

    private void sortSongs(ArrayList<MediaItem> items) {
        items.sort(Comparator.comparing(
            item -> item.mediaMetadata.title == null ? "" : item.mediaMetadata.title.toString(),
            String.CASE_INSENSITIVE_ORDER));
    }

    private JSONObject findStoredSong(String mediaId) throws Exception {
        if (mediaId == null || !mediaId.startsWith(SONG_PREFIX)) return null;
        JSONObject songs = readLibrary().optJSONObject("songs");
        return songs == null ? null : songs.optJSONObject(mediaId.substring(SONG_PREFIX.length()));
    }

    private JSONObject readLibrary() throws Exception {
        File index = new File(getFilesDir(), "zeta/library.json");
        if (!index.isFile()) return new JSONObject();
        try (FileInputStream input = new FileInputStream(index);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    private MediaItem folder(String id, String title) {
        MediaMetadata metadata = new MediaMetadata.Builder()
            .setTitle(title)
            .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
            .setIsBrowsable(true)
            .setIsPlayable(false)
            .build();
        return new MediaItem.Builder().setMediaId(id).setMediaMetadata(metadata).build();
    }

    private MediaItem playableSong(JSONObject stored) throws JSONException {
        String relativePath = stored.optString("file", "");
        if (relativePath.isEmpty()) return null;
        try {
            File root = getFilesDir().getCanonicalFile();
            File audio = new File(root, relativePath).getCanonicalFile();
            String rootPath = root.getPath() + File.separator;
            if (!audio.getPath().startsWith(rootPath) || !audio.isFile()) return null;

            JSONObject song = stored.getJSONObject("song");
            String id = song.optString("id", "");
            if (id.isEmpty()) return null;
            JSONArray artists = song.optJSONArray("artists");
            StringBuilder artistNames = new StringBuilder();
            if (artists != null) {
                for (int i = 0; i < artists.length(); i++) {
                    JSONObject artist = artists.optJSONObject(i);
                    if (artist == null) continue;
                    if (artistNames.length() > 0) artistNames.append(", ");
                    artistNames.append(artist.optString("name", ""));
                }
            }

            MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                .setTitle(song.optString("title", "Unknown track"))
                .setArtist(artistNames.toString())
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .setIsBrowsable(false)
                .setIsPlayable(true);
            JSONObject album = song.optJSONObject("album");
            if (album != null) metadata.setAlbumTitle(album.optString("title", ""));
            JSONArray thumbnails = song.optJSONArray("thumbnails");
            boolean hasArtworkUri = false;
            if (thumbnails != null && thumbnails.length() > 0) {
                for (int i = 0; i < thumbnails.length(); i++) {
                    JSONObject thumbnail = thumbnails.optJSONObject(i);
                    String url = thumbnail == null ? "" : thumbnail.optString("url", "");
                    if (url.startsWith("https://")) {
                        metadata.setArtworkUri(Uri.parse(url));
                        hasArtworkUri = true;
                        break;
                    }
                }
            }
            if (!hasArtworkUri) {
                File cover = new File(audio.getPath().replaceFirst("\\.[^.]+$", ".cover"));
                if (cover.isFile()) metadata.setArtworkUri(Uri.fromFile(cover));
            }
            return new MediaItem.Builder()
                .setMediaId(SONG_PREFIX + id)
                .setUri(Uri.fromFile(audio))
                .setMediaMetadata(metadata.build())
                .build();
        } catch (java.io.IOException error) {
            Log.w(TAG, "Skipping unavailable offline audio file.", error);
            return null;
        }
    }

    @Override
    public void onDestroy() {
        if (active == this) active = null;
        if (equalizer != null) equalizer.release();
        libraryExecutor.shutdown();
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        ZetaPlaybackWidget.refresh(this, null);
        super.onDestroy();
    }
}

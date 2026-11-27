# z3

Media for all.

Zeta lets you listen to your playlists and **own** your music, on desktop and Android.

## Desktop

```sh
npm ci
npm run dev
```

`npm run build` builds the Electron app and `npm run dist` packages it.

If the built-in YouTube player request fails, Zeta retries playback and downloads with [yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation). Zeta looks on PATH and in common install locations, including `~/.local/bin`, Homebrew, WinGet, Scoop, and Chocolatey. Use a current version with its [YouTube challenge scripts and a supported JavaScript runtime](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Zeta enables Node.js 22+ in addition to yt-dlp's default Deno runtime. Restart Zeta after changing PATH.

To use your YouTube session for playback and downloads, choose a signed-in browser profile under **Settings → YouTube → Use browser cookies**. Zeta remembers the profile and asks yt-dlp to read its current cookies for each new YouTube audio request. If the browser’s cookie store is locked or yt-dlp cannot read it, you can also select a [Netscape-format YouTube cookies export](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies). **Clear cookie source** returns to built-in playback with yt-dlp as a fallback.

Desktop includes music search and discovery, playlists, favourites, queue-based
autoplay and radio, lyrics, visualizers, and a video mode for matching music
videos. Playback can use the supported music providers or your own local library.

## Android

Android runs independently of the desktop app. The Svelte interface is bundled with
Capacitor, while a native Media3 service handles playback, audio focus, headphone
disconnects, background audio, and system media controls.

Install Node.js 22.21.1 or newer, JDK 21, and Android Studio with Android SDK 36 and
Build Tools 36. Configure `ANDROID_HOME` or `android/local.properties` to point to
your SDK. See the [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

```sh
npm ci
npm run android:open
```

This builds the Android web assets, syncs the native project, and opens Android
Studio. Choose a phone/emulator and run the app, or use `npm run android:run`.
After changing web code, run `npm run android:sync` before building in Android Studio.

To build an installable debug APK from the command line:

```sh
npm run android:sync
cd android
./gradlew assembleDebug
# Windows: gradlew.bat assembleDebug
```

The APK is `android/app/build/outputs/apk/debug/app-debug.apk`. This workflow builds
locally and does not publish anything.

Signed release builds use `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` from the environment, then
`./gradlew assembleRelease`. Keep the keystore and passwords out of Git and retain
a private backup: Android updates must use the same signing key. A debug APK uses
a different key and cannot be updated in place with the release APK.

Android supports search and downloads from YouTube Music and JioSaavn, playlists,
favourites, lyrics, listening statistics, and offline playback. In Settings,
**Import audio files** opens Android's file picker and copies selected songs into
the library, including embedded artwork. Downloads and imported audio are in the
**Downloads** playlist. Library songs are saved on first playback; search-only
audio uses temporary cache storage. Music providers still require internet access
and may restrict availability by region or change their verification requirements.

The Android library uses private app storage and is separate from desktop. Removing
the app removes this library. Desktop music folders, FTP/SFTP, and
Discord presence are desktop features. Android visualizers animate without the
desktop player's live audio analysis.

Android also has a native share sheet for song links and downloaded audio files,
optional haptic feedback, and an option to keep the screen awake while playing.
These preferences are available in Settings and persist across restarts.

## Updates and library transfers

Zeta checks GitHub Releases at launch and in **Settings → Updates**. Supported
desktop packages download updates in the background and offer **Restart and install**.
Unsigned macOS builds, Windows MSI installs, and portable Windows builds open
the GitHub release page.
On Android, **Install update** verifies the GitHub APK and opens Android's
installer. Android may ask you to allow installs from Zeta first.

**Settings → Zeta backup** saves a `.zetabackup` file on desktop or Android.
Import it on the other device to merge songs, playlists, favourites, and listening
history. Include downloaded audio if it fits within the 128 MiB backup limit.
The backup excludes account credentials and browser cookies.

**Settings → Nearby devices** pairs devices on the same Wi-Fi for direct backup
transfer, playback control, and listening parties. Scan the invitation on the
joining device, then scan its reply on the host. Pairing codes can also be
copied and pasted. Guest devices can queue songs and optionally follow playback.

To build a separate Android test install, run `npm run android:sync`, then
`cd android && ./gradlew -PzetaLocalTest assembleDebug`. The APK installs as
**Zeta Test** alongside Zeta with its own library.

**Settings → Muzza** reads and writes Muzza's `.backup` format on both platforms.
Muzza backups transfer library metadata, playlists, likes, and listening history.
They do not carry the audio files.

## Last.fm and ListenBrainz

Both desktop and Android can send now-playing updates and scrobbles. Connect each
account separately under **Settings → Scrobbling**. Last.fm opens authorization in
your browser; approve Zeta, return to the app, and select **Finish connecting**.
ListenBrainz uses the personal user token from your account settings. Neither
service is enabled until you connect an account. Each can be paused or disconnected.

Scrobbles count audio actually played, excluding pauses and seek jumps. Songs must
be longer than 30 seconds and reach half their duration or four minutes of playback.
Failed listens stay in a local queue and retry at startup, when the network returns,
and once a minute. Successful delivery to one service is not repeated when the
other service needs a retry. Now-playing updates are never put in the offline queue.

Developers can configure Last.fm application credentials in an ignored `.env.local`
using the names in `.env.example`. Build-time application credentials are included
in the local app build; account sessions and ListenBrainz tokens are kept in private
application settings and are not exposed by the settings-status API. Do not commit
real credentials or distribute your own local build credentials unintentionally.

## Zeta for Discord

The optional Discord bot installs to your Discord account and works in eligible
servers and DMs. Link Last.fm or ListenBrainz with a public username to see
what's playing, recent listens, and top tracks and artists. Connect the bot and
an open Zeta player to the same Wayship account for playback controls and lyrics.
See the [bot setup guide](bot/README.md) for installation and commands.

## Publishing a release

The tag workflow builds Windows, macOS (Apple Silicon and Intel), Linux, and a
signed Android APK. Set repository Actions secrets `LASTFM_API_KEY`,
`LASTFM_API_SECRET`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The first two are mapped to Vite's
build-time variable names. Signing material is restored temporarily for the
Android job and removed afterward.

Update `package.json`, `package-lock.json`, and Android's `versionName` together,
increment Android's `versionCode`, and push a matching `v` tag. Release notes live
in `releases/<tag>.md`. All packages upload into a draft; publication waits for
all desktop assets, updater metadata/blockmaps, and the signed Android APK.

## Checks

```sh
npm run check
npm run test:android
npm run test:scrobbling
npm run build
npm run android:sync
```

Android storage tests cover concurrent writes, rollback after disk failures,
preservation of corrupt indexes, protected favourites, and listening statistics.
Native playback follows Android's [MediaSessionService guidance](https://developer.android.com/media/media3/session/background-playback).

# Soundfast

**SoundCloud, as a real desktop app.** Soundfast gives SoundCloud its own window, tray icon, media-key support and mini player, so you never have to open a browser tab to listen. It runs on Windows, macOS and Linux.

Soundfast loads SoundCloud's own web player inside a dedicated app window. You sign in with your normal SoundCloud account, and everything on SoundCloud works the same: your likes, playlists, feed, uploads, comments and SoundCloud Go+.

## Features

- **Its own app.** Start menu entry, taskbar icon, remembers its size and position, and stays signed in.
- **Media keys.** Play/pause, next and previous on your keyboard or headset work even when Soundfast is in the background. Windows' volume/media flyout shows the current track and artwork.
- **Keeps playing in the tray.** Closing the window hides it to the tray. Right-click the tray icon for play/pause, next, previous, like and settings.
- **Mini player.** A small always-on-top player with artwork, controls, like and a seek bar (`Ctrl+M`).
- **Taskbar buttons.** Hover Soundfast on the Windows taskbar for previous / play-pause / next buttons.
- **Track notifications.** A small notification with the artwork when a new track starts (only while Soundfast isn't focused).
- **Start with Windows** (optional), starting quietly in the tray.
- **Links behave.** SoundCloud pages open in the app; everything else opens in your normal browser.
- **Lightweight on privacy.** No accounts, telemetry or servers of its own. A few third-party analytics trackers are blocked.

## Install

### Windows

Download `Soundfast-1.0.0-win-x64.zip` (or the installer) from the [Releases page](https://github.com/moliwater/soundcloud-desktop-client/releases), extract it anywhere (for example `Documents\Soundfast`), and run `Soundfast.exe`.

On first launch Soundfast adds itself to the Start menu so you can find it by searching "Soundfast". Right-click the tray icon → **Settings** → **Create desktop shortcut** if you want one on the desktop.

Because the app isn't code-signed, Windows SmartScreen may say "Windows protected your PC" the first time. Click **More info → Run anyway**. (Code-signing certificates cost money; this is normal for small open-source apps.)

### From source (any OS)

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

### Build installers

```bash
npm run dist:win     # Windows installer + portable .exe  (run on Windows)
npm run dist:mac     # macOS .dmg                         (run on a Mac)
npm run dist:linux   # AppImage + .deb                    (run on Linux)
```

Output goes to `dist/`. If you push this project to GitHub, the included workflow (`.github/workflows/release.yml`) builds all three automatically whenever you push a tag such as `v1.0.1`, and attaches them to a GitHub release.

`tools/build-portable.sh` builds the Windows zip from Linux or macOS without Windows, Wine or npm. It downloads the official Electron release, checks its checksum, and uses `tools/rcpatch.py` to give the exe Soundfast's icon and name.

## Keyboard shortcuts

SoundCloud's own keyboard shortcuts keep working. Soundfast adds:

| Shortcut | Action |
| --- | --- |
| `Ctrl+P` | Play / pause |
| `Ctrl+→` / `Ctrl+←` | Next / previous track |
| `Ctrl+D` | Like / unlike |
| `Ctrl+S` / `Ctrl+E` | Shuffle / repeat |
| `Ctrl+M` | Mini player |
| `Ctrl+L` | Search |
| `Ctrl+J` | Go to the playing track |
| `Ctrl+Shift+L` | Your likes |
| `Ctrl+Shift+Y` | Your library |
| `Ctrl+Shift+H` | Home |
| `Alt+←` / `Alt+→` (or mouse side buttons) | Back / forward |
| `Ctrl+R` or `F5` | Reload |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `F11` | Full screen |
| `Ctrl+Shift+C` | Copy link to current page |
| `Ctrl+Q` | Quit |

On macOS use `Cmd` instead of `Ctrl`. Press `Alt` to show the menu bar.

## Settings

Right-click the tray icon (or press `Alt` → **Soundfast** → **Settings**):

- Close to tray (keep playing) — on by default
- Notification when the track changes — on by default
- Mini player always on top — on by default
- Show track progress on the taskbar — off by default
- Start with Windows — off by default
- Create desktop shortcut

Settings are stored in `%APPDATA%\Soundfast\settings.json` on Windows.

## How it works

| File | What it does |
| --- | --- |
| `src/main.js` | App window, tray, menus, shortcuts, notifications, mini player window, link handling |
| `src/preload.js` | Runs inside the SoundCloud page: reads what's playing from SoundCloud's player bar and presses its buttons when you use media keys, the tray or the mini player |
| `src/mini.html`, `src/mini.js` | The mini player |
| `src/offline.html` | Shown when SoundCloud can't be reached; retries automatically |
| `src/store.js` | Settings file |

If SoundCloud redesigns its player bar and the tray or mini player stop showing the current track, the class names to update are in the `SEL` list at the top of `src/preload.js`.

## Why not fully native like Spotifast?

[Spotifast](https://github.com/crmne/spotifast) can be fully native because it uses librespot, an open-source implementation of Spotify's playback protocol. SoundCloud has nothing equivalent, and it has closed registrations for new API apps, so a native client would have to rely on unofficial endpoints that break and could get accounts flagged. Using SoundCloud's own player keeps everything working, including sign-in and Go+.

## Known limitations

- **Google sign-in** sometimes refuses to work inside apps ("This browser or app may not be secure"). If that happens, sign in with email and password, or with Apple or Facebook.
- A small number of tracks that SoundCloud protects with DRM may not play, because standard Electron doesn't include the Widevine module that Chrome has.

## Disclaimer

Soundfast is an independent, unofficial project and is not affiliated with, endorsed by or sponsored by SoundCloud. SoundCloud is a trademark of its owner.

## License

[MIT](LICENSE)

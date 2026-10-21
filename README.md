# Soundfast

**A desktop app for SoundCloud with its own interface.** Soundfast plays SoundCloud music in a clean, themeable app of its own, with a sidebar for your library, a discovery home page and a Now playing panel with SoundCloud's waveform. It is not the SoundCloud website in a window: the interface is Soundfast's own, and SoundCloud provides the music and your account data. It runs on Windows, macOS and Linux.

## Features

- **Its own interface.** Home with SoundCloud's recommendations, your feed, search, liked tracks, playlists and albums, recently played, following, artist pages and playlist pages.
- **Comments.** Click a track's title (or the comment button in Now playing) to open its page with the comments. Post your own comment; if the track is playing, it is timed to where you are in the song, just like on SoundCloud. Click a comment's time to jump there.
- **Playlists.** The **+** button on any track (and in Now playing) adds it to one of your playlists, or creates a new playlist with it. **New playlist** on the Playlists page makes an empty one.
- **Profiles.** Click your profile picture for your own artist page. On any artist page, click the followers or following count to see those people.
- **Now playing panel.** Big artwork, the track's real SoundCloud waveform as the progress bar, shuffle, repeat, like, volume and an Up next list. Press and drag on the waveform (or any progress bar) to scrub to a new spot; the song jumps there when you let go. Close the panel (or press `Ctrl+B`) for more room: a compact playback bar with the artwork, track name, a seekable progress bar and the controls appears at the bottom instead.
- **Themes.** Charcoal, Midnight, True black and Light, with six accent colors or any color you pick yourself. Change them in Settings; they switch instantly.
- **Your own background.** Use one of your own pictures (PNG or JPG) as the app background, with a blur switch, a blur strength slider and a darken slider so text stays readable. Soundfast keeps its own copy sized to your screen, and pre-blurs it once, so a background adds only about 9 MB of memory.
- **Your SoundCloud account.** Sign in once with your normal SoundCloud login (email, Google, Facebook or Apple). Likes you add or remove in Soundfast are saved to your account.
- **Keeps the music going.** When your queue ends, similar tracks keep playing (can be turned off). Your queue is remembered between launches.
- **No ads.** Soundfast only plays the music, so there are no audio or banner ads.
- **Media keys.** Play/pause, next and previous on your keyboard or headset, and the Windows media flyout, work even in the background.
- **Tray, mini player and taskbar buttons.** Closing the window keeps the music playing in the tray. `Ctrl+M` opens a small always-on-top player.
- **Discord status.** Shows "Listening to SoundCloud" with the track, artist, artwork, a progress bar and a "Listen on SoundCloud" button. Clears when you pause. Can be turned off.
- **Light on memory.** No website is loaded, and low memory mode (on by default) trims Chromium's background processes.
- **Start with Windows** (optional), starting quietly in the tray.

## Install

### Windows

Download `Soundfast-Setup-<version>.exe` from the [Releases page](https://github.com/moliwater/soundcloud-desktop-client/releases) and run it. It installs Soundfast with Start menu and desktop shortcuts.

Prefer not to install? Download `Soundfast-Portable-<version>.exe` instead and run it from anywhere.

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

Output goes to `dist/`. The included workflow (`.github/workflows/release.yml`) builds all three automatically whenever a release with a tag such as `v2.0.1` is published, and attaches them to the release.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Space` | Play / pause (when not typing) |
| `Ctrl+P` | Play / pause |
| `Ctrl+→` / `Ctrl+←` | Next / previous track |
| `Ctrl+D` | Like / unlike |
| `Ctrl+S` / `Ctrl+E` | Shuffle / repeat |
| `Ctrl+L` or `/` | Search |
| `Ctrl+M` | Mini player |
| `Ctrl+B` | Show / hide the Now playing panel |
| `Ctrl+Shift+H` | Home |
| `Ctrl+Shift+F` | Feed |
| `Ctrl+Shift+L` | Liked tracks |
| `Ctrl+Shift+Y` | Playlists |
| `Ctrl+Shift+R` | Recently played |
| `Ctrl+J` | Artist of the playing track |
| `Ctrl+,` | Settings |
| `Alt+←` / `Alt+→` (or mouse side buttons) | Back / forward |
| `Ctrl+Shift+C` | Copy link to the playing track |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `F11` | Full screen |
| `Ctrl+Q` | Quit |

On macOS use `Cmd` instead of `Ctrl`.

## Settings

Open **Settings** at the bottom of the sidebar (or right-click the tray icon → Settings):

- Theme and accent color (including a custom color picker)
- Background image, blur on/off, blur strength, and how much to darken it
- Show what I'm listening to on Discord — on by default
- Track change notifications — on by default
- Keep playing similar tracks when the queue ends — on by default
- Keep playing when the window is closed (close to tray) — on by default
- Mini player always on top — on by default
- Start with Windows — off by default
- Show track progress on the taskbar — off by default
- Low memory mode — on by default (restarts the app when changed)

Settings are stored in `%APPDATA%\Soundfast\settings.json` on Windows.

## How it works

Soundfast talks to SoundCloud's web API (the same one soundcloud.com uses), plays the audio streams itself, and draws everything in its own interface.

| File | What it does |
| --- | --- |
| `src/main.js` | Window, tray, menus, shortcuts, sign-in window, notifications, mini player, settings |
| `src/scapi.js` | SoundCloud data: home, feed, search, likes, library, playlists, artists, streams; trims responses to what the interface needs |
| `src/ui/` | The interface: `index.html`, `app.css` (themes), `app.js` (pages, navigation, player), `icons.js` |
| `src/discord.js` | Discord status, talking directly to the Discord app on your computer (no dependencies) |
| `src/mini.html`, `src/mini.js` | The mini player |
| `src/adblock.js` | Blocks ads and trackers on the SoundCloud sign-in page |
| `src/store.js` | Settings file |

Signing in opens SoundCloud's own sign-in page in a small window. Once SoundCloud has signed you in, the window closes and Soundfast uses that session; your password never passes through Soundfast.

## Known limitations

- **Protected tracks.** Some major-label tracks are copy-protected (DRM) by SoundCloud and only play on SoundCloud's own website and apps. Soundfast marks them with a lock and offers to open them on SoundCloud.
- **Go+ tracks** play as 30-second previews unless your account has SoundCloud Go+.
- Comments, uploads, messages and reposting aren't in Soundfast yet; use the "Open on SoundCloud" button for those.
- Soundfast uses SoundCloud's web API, which isn't an officially documented public API. If SoundCloud changes it, Soundfast may need an update.

## Disclaimer

Soundfast is an independent, unofficial project and is not affiliated with, endorsed by or sponsored by SoundCloud. SoundCloud is a trademark of its owner.

## License

[MIT](LICENSE). Bundles [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0, `src/ui/vendor/hls.js-LICENSE.txt`) as a fallback audio stream player.

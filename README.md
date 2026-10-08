<p align="center">
  <img src="banner.png" alt="Riffle" width="100%">
</p>

# Riffle

Riffle is a desktop music player for Windows and Linux. It plays music from YouTube, SoundCloud and your own files, keeps a local library, and lets you save tracks for offline listening.

The interface follows Material Design 3 (You), and the player stays focused on the music.

Downloads: [latest release](https://github.com/s1mpl3d/riffle/releases/latest)

Riffle is a fork of [Riff](https://github.com/rootscripts/riff) by rootless, with extra playback features on top.

## Features

### Playback

* Crossfade between songs, and on a looped song
* Volume normalization: every track is measured once (LUFS) so songs play at a similar loudness
* Autoplay: when the queue runs low, similar songs are added automatically
* Session restore: the queue and position come back when you reopen the app
* Keeps playing in the tray when the window is closed

### Mini player

A small always-on-top window with cover, progress and controls. Open it from the player bar, the tray menu or with `Ctrl+Alt+P`.

### Global shortcuts

These work even while Riffle is minimized or hidden in the tray (they can be turned off in Settings):

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Space` | Play / pause |
| `Ctrl+Alt+Right` | Next track |
| `Ctrl+Alt+Left` | Previous track |
| `Ctrl+Alt+Up` / `Down` | Volume up / down |
| `Ctrl+Alt+P` | Toggle the mini player |

### Search

* YouTube and SoundCloud, plus Spotify and TikTok (experimental)
* Paste a Spotify or TikTok link to play it directly
* Autocomplete with songs from your library, your recent searches and YouTube suggestions

Spotify audio is not streamed: Riffle reads the track info and plays the matching song from YouTube.

### Library and downloads

* Save songs for offline listening (stored in `Music\Riffle`)
* Playlists, favorites and a Saved view
* Reads common audio tags: title, artist, album, track number, cover art

### Audio editor

* Speed up / slow down in real time
* Reverb, distortion and an equalizer
* Trim the start or end, select a part of a song and save it as a separate file

### Lyrics

* Online search, enabled by default
* Plain text and LRC files
* Word-by-word sync, manual timing and online auto timing

### Discord Rich Presence

Shows the current track, artist and progress on Discord.

## Coming from Riff

On the first start, Riffle imports your settings, playlists, library and custom lyrics from an existing Riff installation. The old folders are only copied, never changed.

## Requirements

* Node.js 18 or newer
* npm
* yt-dlp and ffmpeg

Release builds download yt-dlp and ffmpeg on first use, so nothing has to be installed by hand. For development you can also put them in `bin/`, add them to `PATH`, or point `RIFFLE_YTDLP` / `RIFFLE_FFMPEG` at them.

## Getting started

```bash
git clone https://github.com/s1mpl3d/riffle.git
cd riffle
npm install
npm start
```

## Building

```bash
npm run dist
```

The installer (Windows) or AppImage (Linux) is written to `dist/`.

Pushing a `v*` tag runs the release workflow, which builds both platforms and attaches them to a GitHub release. Installed copies pick up new releases through the built-in updater.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `RIFFLE_PROFILE_DIR` | Use a different profile folder (handy for running a dev copy next to the installed app) |
| `RIFFLE_PORT` | Port of the local server (default `38472`) |
| `RIFFLE_SPOTIFY_CLIENT_ID` / `RIFFLE_SPOTIFY_CLIENT_SECRET` | Use the real Spotify catalog in search instead of the public fallback |
| `RIFFLE_FLAGS` | Extra Chromium switches, separated by `;` |
| `RIFFLE_DEBUG` | Set to `1` to log GPU info and CPU usage |

## Notes

Riffle is meant for educational and personal media management purposes. You are responsible for following local copyright law and the terms of service of any third-party platform you use it with.

Only download and store music you are allowed to.

## License

MIT. See [LICENSE](LICENSE). Based on Riff, © 2026 rootscripts.

# WebRTC + TURN Speaker Streaming

Stream generated audio from a Mac host to an iPhone browser client via WebRTC, with TURN relay support for NAT traversal.

![WebRTC Speaker — Connected](docs/screenshots/webrtc-speaker-connected.png)

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Mac Host                                            │
│                                                      │
│  ┌────────────┐    ┌───────────────────────────────┐ │
│  │   Engine    │    │          Gateway              │ │
│  │            │    │                               │ │
│  │ SineWave / │───▶│  aiohttp server (:8080)       │ │
│  │ TTS gen    │    │  ├─ GET /  → index.html       │ │
│  │            │    │  ├─ GET /ws → WebSocket        │ │
│  └────────────┘    │  │    ├─ hello / hello_ack    │ │
│                    │  │    ├─ webrtc_offer/answer   │ │
│                    │  │    └─ start / stop          │ │
│                    │  │                             │ │
│                    │  └─ RTCPeerConnection          │ │
│                    │     └─ AudioTrack (Opus 48kHz) │ │
│                    └───────────────────────────────┘ │
└──────────────────────┬───────────────────────────────┘
                       │  WebRTC (UDP)
                       │  via TURN relay or direct
                       │
┌──────────────────────▼───────────────────────────────┐
│  iPhone Safari                                       │
│                                                      │
│  ┌───────────────────────────────────────────────┐   │
│  │  web/app.js                                   │   │
│  │  ├─ WebSocket signaling                       │   │
│  │  ├─ RTCPeerConnection (recvonly)              │   │
│  │  └─ <audio> element playback                  │   │
│  └───────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

## Signaling Protocol (WebSocket JSON)

```
Client                          Server
  │                               │
  │─── hello {token} ───────────▶│   Auth check
  │◀── hello_ack {voices} ───────│   Voice list
  │                               │
  │─── webrtc_offer {sdp} ──────▶│   Set remote, create answer
  │◀── webrtc_answer {sdp} ──────│   ICE candidates bundled in SDP
  │                               │
  │─── start {voice_id} ────────▶│   Begin audio generation
  │─── stop ─────────────────────▶│   Stop audio generation
  │                               │
  │─── ping ─────────────────────▶│   Keepalive
  │◀── pong ──────────────────────│
```

**Key constraint**: aiortc does NOT support trickle ICE. All ICE candidates are bundled into the SDP answer. The client waits for ICE gathering to complete before sending its offer.

## Project Structure

```
├── engine/                  # Audio generation layer
│   ├── types.py             # VoiceInfo, AudioChunk dataclasses
│   └── adapter.py           # list_voices(), SineWaveGenerator
│
├── gateway/                 # Server + WebRTC layer
│   ├── server.py            # aiohttp HTTP + WS server
│   ├── webrtc.py            # Session, RTCPeerConnection lifecycle
│   └── audio/
│       ├── pcm_ring_buffer.py        # Thread-safe ring buffer
│       └── webrtc_audio_source.py    # Custom MediaStreamTrack
│
├── web/                     # Browser client
│   ├── index.html           # Mobile-friendly UI
│   ├── app.js               # WS signaling + WebRTC + playback
│   └── styles.css           # Mobile CSS with large touch targets
│
├── web-app/                 # Iris Kade (existing, untouched)
│
├── requirements.txt         # Python dependencies
├── .env.example             # Environment variable template
└── README.md                # This file
```

## Milestones

| # | Goal | Acceptance |
|---|------|------------|
| 1 | Gateway + Signaling | Open localhost:8080, enter token, see voices list |
| 2 | WebRTC Negotiation | Offer/answer exchange, ICE completes, "WebRTC connected" in UI |
| 3 | Sine Wave Streaming | Click Start → hear tone, Stop → silence, switch voice → different frequency |
| 4 | Real TTS (future) | Replace sine wave with actual TTS engine output |

## Quick Start

```bash
# Install Python dependencies
pip install -r requirements.txt

# Create .env from template
cp .env.example .env
# Edit .env to set AUTH_TOKEN and optionally ICE_SERVERS_JSON

# Run the server
python -m gateway.server

# Open in browser
open http://localhost:8080
```

### Testing from iPhone

1. Ensure Mac and iPhone are on the same Wi-Fi network
2. Find your Mac's IP: `ipconfig getifaddr en0`
3. Open `http://<mac-ip>:8080` in Safari on iPhone
4. Enter the auth token and tap Connect
5. Select a voice and tap Start

For connections across different networks, configure TURN servers via `ICE_SERVERS_JSON`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `AUTH_TOKEN` | `devtoken` | Token required in `hello` message |
| `ICE_SERVERS_JSON` | `[]` | JSON array of ICE server configs for TURN/STUN |

### ICE Server Configuration

```bash
# .env example with TURN server
ICE_SERVERS_JSON='[{"urls":"turn:your-server.com:3478","username":"user","credential":"pass"}]'
```

## Key Technical Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Server framework | aiohttp + aiortc | Most mature Python server-side WebRTC |
| Audio sample rate | 48 kHz | Opus codec native rate, no resampling |
| Frame size | 960 samples (20 ms) | Matches aiortc `AUDIO_PTIME` |
| ICE strategy | Client waits for gathering complete | aiortc has no trickle ICE |
| Config delivery | `window.__CONFIG__` in HTML | No extra fetch, client has ICE servers immediately |
| Auth | Token in WS `hello` message | Simple, avoids HTTP header complexity |
| Audio playback | `<audio>` element | Simplest iOS Safari compatibility |

## iOS Safari Notes

- Audio autoplay is blocked until a user gesture — the Start button click triggers `audio.play()`
- Uses `<audio>` element (not AudioContext) for maximum mobile compatibility
- CSS uses large touch targets (min 44px) for iPhone usability
- `playsinline` attribute is required for inline audio on iOS

## Existing: Iris Kade Web App

The `web-app/` directory contains the original Iris Kade conversational AI — a fully local browser-based system using WebGPU. It is independent of the WebRTC streaming system. See `web-app/` for its own documentation.

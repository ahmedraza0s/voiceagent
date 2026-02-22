# AI Voice Agent Backend

Production-ready real-time AI Voice Agent built with Node.js + TypeScript, featuring FreeSWITCH, Deepgram STT, Groq LLM, and Sarvam.ai TTS.

## 🚀 Features

- **Unified Signaling** via FreeSWITCH & Drachtio
- **Inbound/Outbound calls** handled through a single service
- **Speech-to-Text** using Deepgram streaming API
- **LLM Brain** powered by Groq (llama-3.3-70b-versatile)
- **Text-to-Speech** with Sarvam.ai
- **Barge-in Support** - interrupts AI when user speaks
- **Ultra-low Latency** streaming PCM architecture
- **Production-grade Logging** with Winston
- **Docker-ready** telephony stack (drachtio + FreeSWITCH)

## 📋 Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose (for telephony stack)
- Deepgram API key ([sign up](https://console.deepgram.com/))
- Groq API key ([sign up](https://console.groq.com/))
- Sarvam.ai API key

## 🛠️ Installation

### 1. Clone and Install Dependencies

```bash
cd voiceagent/frontend
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

```env
# Deepgram STT
DEEPGRAM_API_KEY=your_deepgram_key

# Groq LLM
GROQ_API_KEY=your_groq_key
GROQ_MODEL=llama-3.3-70b-versatile

# Sarvam.ai TTS
SARVAM_API_KEY=your_sarvam_key

# FreeSWITCH ESL
FREESWITCH_HOST=127.0.0.1
FREESWITCH_PORT=9022
FREESWITCH_PASSWORD=ClueCon

# SIP Registration (VivPhone)
SIP_USERNAME=your_username
SIP_PASSWORD=your_password
SIP_DOMAIN=51.195.161.145
SIP_PORT=5060
SIP_PUBLIC_IP=your_public_ip
```

## 🚦 Running Locally

### 1. Start Telephony Stack (Docker)

```bash
docker-compose up -d
```

### 2. Start Application

```bash
npm run dev
```

## 📞 How It Works

### Streaming Pipeline

```
User Audio (RTP) → FreeSWITCH → Deepgram STT → Groq LLM → Sarvam TTS → FreeSWITCH → User Audio (RTP)
```

### Call Flow

1. **Registration**: Drachtio registers with VivPhone on startup.
2. **Inbound Call**: VivPhone &rarr; Drachtio &rarr; Node App (emits `inboundCall`).
3. **Outbound Call**: Node App &rarr; Drachtio &rarr; VivPhone.
4. **Conversation**: PCM audio flows via UDP/RTP between FreeSWITCH and the Node app.

## 📁 Project Structure

```
voiceagent/
├── frontend/
│   ├── src/
│   │   ├── services/
│   │   │   ├── freeswitch/   # ESL & RTP Bridge
│   │   │   ├── stt/          # Deepgram streaming
│   │   │   ├── llm/          # Groq streaming
│   │   │   ├── tts/          # Sarvam streaming
│   │   │   ├── sip/          # High-level SIP service
│   │   │   └── conversation/ # Pipeline orchestrator
│   │   ├── utils/            # Logging, Digest Auth
│   │   └── index.ts          # Express Server & Entry
│   ├── public/               # Frontend Dialer UI
│   ├── docker-compose.yml    # Telephony stack
│   └── .env                  # Secrets
└── logs/                     # System logs
```

## 📊 Monitoring

View real-time logs:

```bash
# App logs
Get-Content logs/combined.log -Wait -Tail 50

# Docker logs
docker logs -f drachtio-server
docker logs -f freeswitch
```

## 🔐 Security

- Never commit `.env` to version control.
- Ensure only required ports (3000, 5062, 16384-16484) are exposed.
- Periodically rotate SIP and API credentials.

## 📄 License

MIT

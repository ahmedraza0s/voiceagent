# AI Voice Agent Backend

Production-ready real-time AI Voice Agent built with Node.js + TypeScript, featuring LiveKit Cloud, Deepgram STT, Groq LLM, and Sarvam.ai TTS.

## 🚀 Features

- **Real-time Audio Streaming** via LiveKit Cloud
- **SIP Integration** for inbound/outbound calls
- **Speech-to-Text** using Deepgram streaming API
- **LLM Brain** powered by Groq (llama-3.3-70b-versatile)
- **Text-to-Speech** with Sarvam.ai
- **Barge-in Support** - interrupts AI when user speaks
- **Ultra-low Latency** streaming architecture
- **Production-grade Logging** with Winston
- **Automatic Retry Logic** for API calls
- **TypeScript** for type safety

## 📋 Prerequisites

- Node.js 18+ and npm
- LiveKit Cloud account ([sign up](https://cloud.livekit.io/))
- Deepgram API key ([sign up](https://console.deepgram.com/))
- Groq API key ([sign up](https://console.groq.com/))
- Sarvam.ai API key
- (Optional) SIP trunk credentials for phone calls

## 🛠️ Installation

### 1. Clone and Install Dependencies

```bash
cd voiceagent
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

```env
# LiveKit Cloud
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret

# Deepgram STT
DEEPGRAM_API_KEY=your_deepgram_key

# Groq LLM
GROQ_API_KEY=your_groq_key
GROQ_MODEL=llama-3.3-70b-versatile

# Sarvam.ai TTS
SARVAM_API_KEY=your_sarvam_key

# SIP Configuration (optional)
SIP_USERNAME=your_sip_username
SIP_PASSWORD=your_sip_password
SIP_DOMAIN=your_sip_domain
SIP_PORT=5060
SIP_CALLER_ID=+1234567890
```

## 🚦 Running Locally

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

## 📞 How It Works

### Streaming Pipeline

```
User Audio → LiveKit → Deepgram STT → Groq LLM → Sarvam TTS → LiveKit → User Audio
```

### Call Flow

1. **Outbound Call**: Create room → Dial SIP → Join bot → Start pipeline
2. **Inbound Call**: Accept SIP → Route to room → Join bot → Start pipeline
3. **Conversation**: Audio streams through STT → LLM → TTS continuously
4. **Barge-in**: System stops TTS immediately when user interrupts

## 🔧 Configuration

### LiveKit Cloud Setup

1. Go to [LiveKit Cloud](https://cloud.livekit.io/)
2. Create a new project
3. Copy your WebSocket URL, API Key, and API Secret
4. Add them to `.env`

### SIP Trunk Configuration

For production phone calls, configure SIP trunk:

1. Obtain SIP credentials from your provider
2. Add credentials to `.env`
3. Configure LiveKit SIP following [their docs](https://docs.livekit.io/realtime/client/sip/)

### Sarvam.ai Setup

1. Sign up at Sarvam.ai
2. Get your API key
3. Add to `.env`

## 📁 Project Structure

```
voiceagent/
├── src/
│   ├── config/           # Environment configuration
│   ├── services/
│   │   ├── stt/          # Deepgram Speech-to-Text
│   │   ├── llm/          # Groq LLM
│   │   ├── tts/          # Sarvam.ai Text-to-Speech
│   │   ├── sip/          # SIP call handling
│   │   ├── rooms/        # LiveKit room management
│   │   └── conversation/ # Pipeline orchestration
│   ├── utils/            # Logging, retry logic
│   └── index.ts          # Application entry point
├── logs/                 # Application logs
├── .env                  # Environment variables (not in git)
├── package.json          # Dependencies
└── tsconfig.json         # TypeScript configuration
```

## 🚀 Deployment

### Deploy to VPS (Ubuntu/Debian)

```bash
# 1. SSH into your VPS
ssh user@your-vps-ip

# 2. Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Clone your repository
git clone your-repo-url
cd voiceagent

# 4. Install dependencies
npm install

# 5. Configure environment
cp .env.example .env
nano .env  # Edit with your credentials

# 6. Build the project
npm run build

# 7. Run with PM2 (process manager)
sudo npm install -g pm2
pm2 start dist/index.js --name voice-agent
pm2 save
pm2 startup
```

## 📊 Monitoring

View logs:

```bash
# Real-time logs
pm2 logs voice-agent

# Log files
tail -f logs/combined.log
tail -f logs/error.log
```

## 🔍 Troubleshooting

### Common Issues

**LiveKit Connection Fails**
- Verify `LIVEKIT_URL` starts with `wss://`
- Check API key and secret are correct
- Ensure firewall allows WebSocket connections

**Deepgram Errors**
- Verify API key is valid
- Check internet connectivity
- Review logs for specific errors

**Groq Rate Limits**
- Implement request throttling
- Upgrade Groq plan if needed

**Sarvam TTS Timeout**
- Check API key
- Verify network connectivity
- Monitor Sarvam.ai status page

## 📝 API Usage

### Making Outbound Calls

```typescript
import { VoiceAgentApp } from './index';

const app = new VoiceAgentApp();

// Make a call
await app.makeOutboundCall('+1234567890');

// End a call
await app.endCall('room-name');

// Get active calls
const calls = app.getActiveCalls();
```

## 🔐 Security

- Never commit `.env` to version control
- Rotate API keys regularly
- Use HTTPS/WSS in production
- Implement rate limiting
- Monitor usage and costs

## 📄 License

MIT

## 🤝 Support

For issues or questions:
- Check logs in `logs/` directory
- Review LiveKit documentation
- Contact API providers for service-specific issues

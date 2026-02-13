# Quick Start Guide

## 1. Install Dependencies

```bash
npm install
```

## 2. Configure Environment

Edit `.env` file (already created with your credentials):
- ✅ LiveKit configured
- ✅ Deepgram configured  
- ✅ Groq configured
- ✅ Sarvam.ai configured
- ⚠️ SIP trunk - add credentials if needed for phone calls

## 3. Run the Application

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

## 4. Test the System

The application will start and wait for calls. To test:

### Option A: Modify `src/index.ts`

Uncomment the example code in `main()` function:

```typescript
// Make a test outbound call
await app.makeOutboundCall('+1234567890');
```

### Option B: Integrate with Web Interface

Create an HTTP API endpoint to trigger calls programmatically.

## 5. Monitor Logs

Logs are written to:
- Console (real-time, colorized)
- `logs/combined.log` (all logs)
- `logs/error.log` (errors only)

## What Happens During a Call

1. **Room Creation**: LiveKit room created for the call
2. **Audio Streaming**: Real-time audio transmitted via LiveKit
3. **Speech Recognition**: Deepgram transcribes user speech
4. **AI Response**: Groq generates intelligent responses
5. **Text-to-Speech**: Sarvam.ai converts text to natural voice
6. **Barge-in**: User can interrupt AI mid-sentence

## Next Steps

1. ✅ Dependencies installed
2. ✅ Environment configured
3. 🔄 Run `npm run dev` to start
4. 📞 Configure SIP trunk for real phone calls
5. 🌐 Build HTTP API for call management
6. 🚀 Deploy to production VPS

## Troubleshooting

**If npm install fails:**
```bash
# Clear cache and retry
npm cache clean --force
npm install
```

**If TypeScript errors:**
```bash
# Check TypeScript version
npx tsc --version

# Rebuild
npm run build
```

**Runtime errors:**
- Check `.env` file has all required keys
- Verify API keys are valid
- Check `logs/error.log` for details

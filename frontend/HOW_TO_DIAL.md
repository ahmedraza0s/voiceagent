# How to Make Calls

## Your Current Output (This is GOOD! ✅)

```
2026-02-11 20:46:04 [info]: Starting AI Voice Agent Backend
2026-02-11 20:46:04 [info]: Voice Agent ready
```

This means your app is **running and ready**! It's just waiting for you to tell it to make a call.

---

## Option 1: Test Call (Recommended for Testing)

**Edit `src/index.ts` and uncomment line 94:**

```typescript
// Change this line (line 94):
// await app.makeOutboundCall('+1234567890');

// To this (replace with your number):
await app.makeOutboundCall('+919876543210');
```

**Then restart:**
```bash
npm run dev
```

**You'll see:**
```
[info]: Starting AI Voice Agent Backend
[info]: Voice Agent ready
[info]: Making outbound call { phoneNumber: '+919876543210' }
[info]: Initiating outbound call
[info]: Room created
[info]: SIP call initiated (placeholder)
[info]: Starting conversation pipeline
[info]: Creating LiveKit room
[info]: Connecting to Deepgram STT...
[info]: Pipeline ready
```

---

## Option 2: Create a Web API (For Production)

Create a simple HTTP endpoint to trigger calls from your frontend or webhook.

**Install Express:**
```bash
npm install express
npm install --save-dev @types/express
```

**Create `src/api.ts`:**
```typescript
import express from 'express';
import { VoiceAgentApp } from './index';

const app = express();
app.use(express.json());

const voiceAgent = new VoiceAgentApp();

// Endpoint to make outbound call
app.post('/call/outbound', async (req, res) => {
    const { phoneNumber } = req.body;
    
    try {
        await voiceAgent.makeOutboundCall(phoneNumber);
        res.json({ success: true, message: 'Call initiated' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint to list active calls
app.get('/calls/active', (req, res) => {
    const activeCalls = voiceAgent.getActiveCalls();
    res.json({ activeCalls });
});

app.listen(3000, () => {
    console.log('API server running on http://localhost:3000');
});
```

**Then call it:**
```bash
curl -X POST http://localhost:3000/call/outbound \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+919876543210"}'
```

---

## Important Notes

### 🚨 For Real Phone Calls

Before dialing **real phone numbers**, you need:

1. **SIP Trunk Credentials** - Add to `.env`:
   ```env
   SIP_USERNAME=your_sip_username
   SIP_PASSWORD=your_sip_password
   SIP_DOMAIN=sip.yourprovider.com
   SIP_CALLER_ID=+1234567890
   ```

2. **LiveKit SIP Integration** - Follow [LiveKit SIP docs](https://docs.livekit.io/realtime/client/sip/)

### 📞 Phone Number Format

Always use **E.164 format**:
- ✅ Correct: `+919876543210` (India)
- ✅ Correct: `+14155552671` (US)
- ❌ Wrong: `9876543210`
- ❌ Wrong: `+91-9876543210`

---

## What Happens When You Make a Call

1. **Room Created** - LiveKit room is created
2. **SIP Dial** - System initiates SIP call (requires SIP trunk)
3. **Pipeline Starts** - STT, LLM, TTS services connect
4. **Call Active** - User can speak, AI responds
5. **Conversation Logs** - All transcripts logged

---

## Quick Test (Right Now!)

**Edit line 94 in `src/index.ts`:**
```typescript
await app.makeOutboundCall('+919999999999');  // Your test number
```

**Run:**
```bash
npm run dev
```

You'll see the full pipeline start! 🚀

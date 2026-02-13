# LiveKit SIP Setup Guide

## Overview

To enable actual phone calls with audio routing to your AI agent, you need to configure LiveKit's SIP service. This bridges SIP calls with LiveKit's WebRTC infrastructure, allowing the AI to hear and speak.

## Prerequisites

- ✅ LiveKit Cloud account (you already have this)
- ✅ VivPhone SIP trunk credentials (configured in `.env`)
- LiveKit SIP feature enabled (may require specific plan)

## Step-by-Step Setup

### 1. Access LiveKit Cloud Dashboard

1. Go to [https://cloud.livekit.io/](https://cloud.livekit.io/)
2. Log in with your credentials
3. Select your project: `voiceagent-e3oy4baz`

### 2. Enable SIP Service

1. Navigate to **Settings** → **SIP**
2. Click **Enable SIP** (if not already enabled)
3. Note: This feature may require upgrading your plan

### 3. Configure SIP Trunk

Add your VivPhone credentials as a SIP trunk:

#### Trunk Details
- **Name:** `VivPhone Trunk`
- **SIP Server:** `vivap1.vivphone.com`
- **Port:** `5060`
- **Transport:** `UDP`
- **Username:** `00919240065378` (from your `.env`)
- **Password:** `0oU&WgQn.48W` (from your `.env`)
- **Caller ID:** `+919240065378`

#### Authentication
- **Auth Username:** Same as username above
- **Auth Password:** Same as password above
- **Realm:** `vivap1.vivphone.com`

### 4. Configure Inbound Rules (Optional)

If you want to receive calls:

1. Go to **SIP** → **Inbound Rules**
2. Add rule:
   - **Phone Number Pattern:** `*` (match all)
   - **Room Name Template:** `inbound-{callId}`
   - **Dispatch Rule:** Create new room

### 5. Configure Outbound Rules

For making calls from your application:

1. Go to **SIP** → **Outbound Rules**
2. Add rule:
   - **Number Pattern:** `*` (match all numbers)
   - **Trunk:** Select "VivPhone Trunk"
   - **Number Format:** `E.164` (recommended)

### 6. Update Your Code

Once LiveKit SIP is configured, update your backend to use LiveKit's SIP API instead of direct SIP:

#### Install LiveKit SIP SDK

```bash
npm install @livekit/rtc-node
```

#### Modify `src/services/sip/index.ts`

Replace the direct SIP dialing with LiveKit's SIP API:

```typescript
import { SIPService } from 'livekit-server-sdk';

async makeOutboundCall(phoneNumber: string): Promise<string> {
    const roomName = `call-${Date.now()}`;
    
    // Create room
    await this.roomService.createRoom({
        name: roomName,
        emptyTimeout: 300,
    });
    
    // Make SIP call via LiveKit
    const sipClient = new SIPService(
        config.livekit.url,
        config.livekit.apiKey,
        config.livekit.apiSecret
    );
    
    await sipClient.createSIPParticipant(roomName, {
        sipCallTo: phoneNumber,
        sipTrunkId: 'your-trunk-id', // Get from LiveKit dashboard
        participantIdentity: `sip-${phoneNumber}`,
        participantName: phoneNumber,
    });
    
    return roomName;
}
```

### 7. Test the Integration

1. Restart your server
2. Make a call from the frontend
3. The call should now have audio!

**Expected flow:**
1. Frontend calls `/api/call`
2. Backend creates LiveKit room
3. Backend triggers SIP call via LiveKit
4. LiveKit connects to VivPhone
5. VivPhone dials your number
6. When you answer, audio routes: **Phone ↔ LiveKit ↔ AI Pipeline**

## Troubleshooting

### SIP Feature Not Available
- Check your LiveKit plan
- Contact LiveKit support to enable SIP

### Trunk Configuration Errors
- Verify VivPhone credentials
- Check that the domain/port are correct
- Ensure UDP port 5060 isn't blocked

### No Audio During Call
- Verify the conversation pipeline is connected to the room
- Check LiveKit logs for SIP participant connection
- Ensure WebRTC permissions are configured

### Calls Don't Connect
- Review LiveKit SIP logs in the dashboard
- Check that outbound rules match your number format
- Verify VivPhone account has credit

## Alternative: Quick Test Without LiveKit SIP

If you want to test the AI immediately without setting up LiveKit SIP:

1. Use the test endpoint: **http://localhost:3000/test.html**
2. Type a message and click "Test AI Response"
3. This verifies the AI pipeline (LLM + logic) works
4. Audio won't play, but you'll see the text response

## Cost Considerations

- LiveKit SIP may have additional usage fees
- VivPhone charges per minute for calls
- Monitor your usage in both dashboards

## Need Help?

- **LiveKit Docs:** [https://docs.livekit.io/realtime/client/sip/](https://docs.livekit.io/realtime/client/sip/)
- **LiveKit Support:** support@livekit.io
- **VivPhone Support:** Your VivPhone account representative

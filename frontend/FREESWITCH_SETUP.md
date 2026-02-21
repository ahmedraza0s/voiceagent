# FreeSWITCH & drachtio Setup Guide

To run the AI Voice Agent, you need the telephony infrastructure running in the background. The recommended way is using **Docker**.

## 🚀 Option 1: Docker (Recommended)

Since you have Docker and Docker Compose installed, run this command in your terminal:

```powershell
docker-compose up -d
```

### What this does:
1.  **Starts drachtio-server**: Handles the SIP connection to your carrier (VivPhone).
2.  **Starts FreeSWITCH**: Handles the audio stream and bridges it to your AI.

### To check if it's working:
Run `docker-compose logs -f` to see the logs. Once you see "drachtio-server listening on 9022", you are ready!

---

## 🛠️ Option 2: Manual Installation (Windows)

If you prefer not to use Docker, follow these steps:

### 1. Install FreeSWITCH
- Download the installer: [FreeSWITCH MSI](https://files.freeswitch.org/windows/installer/x64/)
- Run the installer and add FreeSWITCH to your Path.
- Start it by running `FreeConsole.exe`.

### 2. Install drachtio-server
- Download the Windows binary from the [drachtio releases](https://github.com/drachtio/drachtio-server/releases).
- Run it with: `drachtio.exe --contact "sip:*:9022;transport=tcp" --secret ClueCon`

---

## 🔗 Connecting the AI Agent

1.  Ensure your `.env` file has:
    ```env
    FREESWITCH_HOST=127.0.0.1
    FREESWITCH_PORT=11444
    FREESWITCH_PASSWORD=ClueCon
    ```
2.  Run the Node.js application:
    ```powershell
    npm run dev
    ```
3.  You should see: `✅ Connected to FreeSWITCH at 127.0.0.1:9022`

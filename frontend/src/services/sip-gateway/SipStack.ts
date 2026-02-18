
const sip = require('sip');
import { EventEmitter } from 'events';
import logger from '../../utils/logger';


export interface SipStackConfig {
    port: number;
    publicIp?: string;
}

export class SipStack extends EventEmitter {
    private config: SipStackConfig;

    constructor(config: SipStackConfig) {
        super();
        this.config = config;
    }

    start() {
        sip.start({
            port: this.config.port,
            checkUri: false, // Don't check URI, allow all
            logger: {
                send: (message: string) => logger.debug(`SIP SEND: ${message}`),
                recv: (message: string) => logger.debug(`SIP RECV: ${message}`),
                error: (e: Error) => logger.error(`SIP ERROR: ${e.message}`)
            }
        }, (request: any) => {
            this.handleRequest(request);
        });

        logger.info(`SIP Stack started on port ${this.config.port}`);
    }

    stop() {
        sip.stop();
        logger.info('SIP Stack stopped');
    }

    send(message: any, callback?: (response: any) => void) {
        sip.send(message, callback);
    }

    private handleRequest(request: any) {
        logger.debug(`SIP Request: ${request.method} ${request.headers['call-id']}`);
        this.emit('request', request);

        // Simple default handling for now
        if (request.method === 'OPTIONS') {
            sip.send(sip.makeResponse(request, 200, 'OK'));
        }
    }
}

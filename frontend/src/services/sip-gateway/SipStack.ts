
const sip = require('sip');
import { EventEmitter } from 'events';
import logger from '../../utils/logger';


export interface SipStackConfig {
    port: number;
    publicIp?: string;
}

export class SipStack extends EventEmitter {
    public config: SipStackConfig;
    private started: boolean = false;

    constructor(config: SipStackConfig) {
        super();
        this.config = config;
    }

    start() {
        // Catch unhandled errors from the sip module's internal UDP socket
        // (the sip npm module emits errors as uncaughtException, not as EventEmitter events)
        process.on('uncaughtException', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(
                    `SIP Stack port conflict (EADDRINUSE) on port ${this.config.port}. ` +
                    `Kill any process using this port and restart. Continuing without SIP stack.`
                );
            } else {
                logger.error('Uncaught exception', { error: err.message, stack: err.stack });
            }
        });

        try {
            sip.start({
                port: this.config.port,
                checkUri: false,
                logger: {
                    send: (message: any) => logger.debug('SIP SEND', { message }),
                    recv: (message: any) => logger.debug('SIP RECV', { message }),
                    error: (e: Error) => logger.error(`SIP ERROR: ${e.message}`)
                }
            }, (request: any) => {
                this.handleRequest(request);
            });

            this.started = true;
            logger.info(`SIP Stack started on port ${this.config.port}`);
        } catch (err: any) {
            if (err.code === 'EADDRINUSE') {
                logger.warn(
                    `SIP port ${this.config.port} is already in use. ` +
                    `SIP Stack not started. Kill any existing process using this port and restart.`
                );
            } else {
                logger.error(`Failed to start SIP Stack: ${err.message}`);
            }
        }
    }

    stop() {
        if (this.started) {
            try {
                sip.stop();
            } catch (_) {
                // Ignore errors on stop
            }
        }
        logger.info('SIP Stack stopped');
    }

    send(message: any, callback?: (response: any) => void) {
        if (!this.started) {
            logger.warn('SIP Stack not started, cannot send message');
            return;
        }
        sip.send(message, callback);
    }

    private handleRequest(request: any) {
        logger.debug(`SIP Request: ${request.method} ${request.headers['call-id']}`);
        this.emit('request', request);

        if (request.method === 'OPTIONS') {
            sip.send(sip.makeResponse(request, 200, 'OK'));
        }
    }
}

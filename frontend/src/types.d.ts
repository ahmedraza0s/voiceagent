
declare module 'sip' {
    export function start(options: any, callback: (request: any) => void): void;
    export function stop(): void;
    export function send(message: any, callback?: (response: any) => void): void;
    export function makeResponse(request: any, status: number, reason: string): any;
}

declare module 'digest-auth' {
    export default function digestAuthenticated(
        method: string,
        uri: string,
        challenge: any,
        credentials: any
    ): string;
}


import crypto from 'crypto';

export function calculateDigest(
    method: string,
    uri: string,
    username: string,
    password: string,
    realm: string,
    nonce: string,
    qop?: string,
    cnonce?: string,
    nc?: string
): string {
    const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');

    let response: string;
    if (qop) {
        if (!cnonce || !nc) {
            throw new Error('cnonce and nc required for qop');
        }
        response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
    } else {
        response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    }

    return response;
}

export function parseChallenge(header: string): Record<string, string> {
    const challenge: Record<string, string> = {};
    const parts = header.replace(/Digest\s+/, '').split(/,(?=(?:[^"]|"[^"]*")*$)/);

    parts.forEach(part => {
        const [key, value] = part.split('=').map(s => s.trim());
        if (key && value) {
            challenge[key] = value.replace(/^"|"$/g, '');
        }
    });

    return challenge;
}

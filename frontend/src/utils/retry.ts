import logger from './logger';
import axios from 'axios';

interface RetryOptions {
    maxAttempts?: number;
    delayMs?: number;
    exponentialBackoff?: boolean;
    onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Check if an error is a deliberate abort/cancellation and should NOT be retried.
 * Covers: AbortController signals, axios cancels ("canceled"), and Groq stream aborts.
 */
function isAbortError(error: any): boolean {
    if (!error) return false;
    // AbortController
    if (error.name === 'AbortError') return true;
    // Axios cancel
    if (axios.isCancel(error)) return true;
    // "canceled" string from Groq SDK / node-fetch
    if (typeof error.message === 'string' && error.message.toLowerCase() === 'canceled') return true;
    // AbortSignal triggered
    if (error.code === 'ERR_CANCELED') return true;
    return false;
}

/**
 * Retry a function with exponential backoff.
 * Intentional aborts (barge-in, user cancel) are rethrown immediately without retrying.
 */
export async function retry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const {
        maxAttempts = 3,
        delayMs = 1000,
        exponentialBackoff = true,
        onRetry,
    } = options;

    let lastError: Error;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            // Never retry intentional aborts — throw immediately
            if (isAbortError(lastError)) {
                throw lastError;
            }

            if (attempt === maxAttempts) {
                logger.error('Max retry attempts reached', {
                    attempts: maxAttempts,
                    error: lastError.message,
                });
                throw lastError;
            }

            const delay = exponentialBackoff
                ? delayMs * Math.pow(2, attempt - 1)
                : delayMs;

            logger.warn(`Retry attempt ${attempt}/${maxAttempts}`, {
                delay,
                error: lastError.message,
            });

            if (onRetry) {
                onRetry(attempt, lastError);
            }

            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw lastError!;
}


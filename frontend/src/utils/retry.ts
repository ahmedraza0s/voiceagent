import logger from './logger';

interface RetryOptions {
    maxAttempts?: number;
    delayMs?: number;
    exponentialBackoff?: boolean;
    onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry a function with exponential backoff
 * Used for external API calls (Deepgram, Groq, Sarvam)
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

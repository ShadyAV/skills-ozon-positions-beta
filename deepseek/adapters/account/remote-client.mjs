import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { FileOAuthProvider, REMOTE_URL, createTrustedFetch, LoginRequiredError } from './oauth.mjs';
export const isLoginRequired = (error) => error instanceof LoginRequiredError || error instanceof UnauthorizedError || error instanceof InvalidGrantError;
// `version` is the package version the root read.
export async function connectRemoteClient({ provider = new FileOAuthProvider(), fetchImpl = createTrustedFetch(), version = '0.0.0-development' } = {}) {
    if (!(await provider.tokens())?.access_token)
        throw new LoginRequiredError();
    const client = new Client({ name: 'e-comet-deepseek-harness', version }, { capabilities: {} });
    const unlink = new AbortController();
    // Transport close does not cancel the SDK's detached OAuth flow. Explicit unlink and
    // abandoned bootstrap stop it; ordinary mounted pause/close retain a finishing refresh.
    client.forgetLogin = async () => {
        const stopped = provider.stopSaving?.();
        unlink.abort();
        await stopped;
    };
    const transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), { authProvider: provider,
        fetch: (input, init = {}) => fetchImpl(input, { ...init,
            signal: init.signal ? AbortSignal.any([init.signal, unlink.signal]) : unlink.signal }),
    });
    // The SDK's transport declares optional fields the client's options read as possibly undefined.
    try {
        await client.connect(transport);
        return client;
    }
    catch (error) {
        // Runtime never receives this client, so it cannot fence a later OAuth save on unlink.
        await client.forgetLogin();
        await client.close().catch(() => { });
        if (isLoginRequired(error))
            throw new LoginRequiredError();
        throw error;
    }
}

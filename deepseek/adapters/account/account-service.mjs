import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ACCOUNT_HOST } from './account-rpc.mjs';
// The root always passes the account and the updates; a call without one fails, as reading through it always did.
const present = (value) => {
    if (value === undefined)
        throw new TypeError('The e-Comet account service is missing a dependency.');
    return value;
};
export class AccountService extends TypertRemoteService {
    static inject = ['typert'];
    constructor(ctx, { account, connections, localStatus, updates } = {}) {
        super(ctx, 'eCometAccount', { namespace: 'eCometAccount' });
        this.account = account;
        this.connections = connections;
        this.localStatus = localStatus;
        this.updates = updates;
        // The fixed gateway name assumes one live plugin instance: see "Native DeepSeek registrations assume one live
        // plugin instance" in docs/architecture/residuals/deepseek.md.
        ctx.effect(() => ctx.typert.register(ACCOUNT_HOST));
    }
    async getStatus() {
        const local = this.connections && this.localStatus ? await this.localStatus() : undefined;
        // Recovery may finish during the bridge read; snapshot all synchronous state afterward.
        const connections = this.connections ? { ...this.connections, ...(this.localStatus ? { local } : {}) } : undefined;
        return {
            ...present(this.account).getStatus(),
            ...(connections ? { connections } : {}),
            ...(this.updates ? { updates: this.updates.getStatus() } : {}),
        };
    }
    accountAction(execute) {
        return this.updates ? this.updates.runTool(execute) : execute();
    }
    startLogin() {
        // Return the browser URL promptly, but block updates until OAuth has settled.
        let resolve;
        let reject;
        const ready = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        Promise.resolve(this.accountAction(async () => {
            resolve(await present(this.account).startLogin());
            await present(this.account).waitForLogin?.();
        })).catch(reject);
        return ready;
    }
    cancelLogin() {
        return this.accountAction(() => present(this.account).cancelLogin());
    }
    disconnect() {
        return this.accountAction(() => present(this.account).disconnect());
    }
    installUpdate() {
        return present(this.updates).installUpdate();
    }
    checkUpdates() {
        return present(this.updates).checkUpdates();
    }
}

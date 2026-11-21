import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// ACP is an independent subprocess. Only the documented JSON-RPC surface is
// used; filesystem and terminal requests are denied unless explicitly handled.
export class AcpClient {
  constructor({ command = 'kimi', args = ['acp'], env, onUpdate = () => {}, onRequest } = {}) {
    this.command = command; this.args = args; this.env = env; this.onUpdate = onUpdate; this.onRequest = onRequest;
    this.nextId = 1; this.pending = new Map();
  }
  start() {
    if (this.child) throw new Error('ACP already started');
    this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe','pipe','pipe'] });
    this.child.stderr.resume();
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', (code, signal) => this.fail(new Error(`ACP exited (${code ?? signal})`)));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return this.fail(new Error('Invalid ACP response')); }
      if (msg.method && msg.id !== undefined) {
        Promise.resolve(this.onRequest?.(msg.method,msg.params)).then(result => {
          this.send(result === undefined ? {jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Client capability unavailable'}} : {jsonrpc:'2.0',id:msg.id,result});
        }).catch(()=>{ if(this.child?.stdin.writable)this.send({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:'Client request failed'}}); });
      } else if (msg.method) this.onUpdate(msg.method, msg.params);
      else if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id); if (!pending) return;
        this.pending.delete(msg.id); clearTimeout(pending.timer);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error.message), { code:msg.error.code }));
        else pending.resolve(msg.result);
      }
    });
    return this;
  }
  send(message) { if (!this.child?.stdin.writable) throw new Error('ACP unavailable'); this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ACP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try { this.send({jsonrpc:'2.0',id,method,params}); } catch(e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async initialize() { return this.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'lumi-server',version:'1.0'}}); }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  close() { this.fail(new Error('ACP closed')); this.child?.kill(); this.child = null; }
}

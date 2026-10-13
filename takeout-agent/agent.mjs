import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const execFileAsync = promisify(execFile);
const api = String(process.env.LUMI_API_URL || 'https://lumi-tokyo-api.zeabur.app').replace(/\/$/, '');
const cdp = process.env.LUMI_TAKEOUT_CDP_URL || 'http://127.0.0.1:9222';
const orderScript = process.env.LUMI_TAKEOUT_ORDER_SCRIPT || join(homedir(), 'Documents/Codex/ai-order-takeout/script/order.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

function readToken() {
  if (process.env.LUMI_PUSH_API_TOKEN) return process.env.LUMI_PUSH_API_TOKEN.trim();
  for (const account of ['takeout-bridge-token', 'push-api-token']) {
    try { return execFileSync('security', ['find-generic-password', '-s', 'com.cai5232.Lumi', '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch {}
  }
  return '';
}
const token = readToken();
if (!token) {
  console.error('Lumi API 令牌没找到。请先在 Lumi 设置里保存推送 API 令牌。');
  process.exit(1);
}

async function apiRequest(path, options = {}) {
  const { timeout = 15_000, ...fetchOptions } = options;
  const response = await fetch(`${api}${path}`, {
    ...fetchOptions,
    headers: { authorization: `Bearer ${token}`, ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}), ...fetchOptions.headers },
    signal: AbortSignal.timeout(timeout)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Lumi API 返回 ${response.status}`);
  return body;
}

function challenge(text) {
  return /请选择符合描述|安全验证|滑动验证|拖动滑块|人机验证|captcha|验证码|请完成验证|向右滑动|依次点击/i.test(text);
}

async function clickText(page, regex) {
  const target = await page.evaluate(source => {
    const pattern = new RegExp(source, 'i');
    const elements = [...document.querySelectorAll('button,[role="button"],a,div,span')]
      .map(element => ({ element, text: (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(), rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(item => item.text.length > 0 && item.text.length < 40 && pattern.test(item.text) && item.rect.width > 28 && item.rect.height > 18 && item.rect.bottom > 0 && item.rect.top < innerHeight && item.style.display !== 'none' && item.style.visibility !== 'hidden')
      .sort((a, b) => a.text.length - b.text.length || b.rect.top - a.rect.top);
    const chosen = elements[0];
    if (!chosen) return null;
    chosen.element.scrollIntoView({ block: 'center' });
    const rect = chosen.element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: chosen.text };
  }, regex.source);
  if (!target) return null;
  await page.mouse.click(target.x, target.y);
  return target.text;
}

async function openPage() {
  const browser = await chromium.connectOverCDP(cdp, { timeout: 8_000 });
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new Error('专用 Chrome 没有浏览器上下文。'); }
  const page = context.pages().reverse().find(tab => {
    try {
      const url = new URL(tab.url());
      return /(^|\.)ele\.me$/i.test(url.hostname) &&
        !/order-detail|address|cashier|payment|\/pay|\/login|checkout|confirm/i.test(url.pathname);
    } catch { return false; }
  }) || await context.newPage();
  let restoreWindow = async () => {};
  try {
    const browserSession = await browser.newBrowserCDPSession();
    const pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const { windowId } = await browserSession.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    const { bounds } = await browserSession.send('Browser.getWindowBounds', { windowId });
    if (bounds.width > 520) {
      await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { width: 430, height: 920, windowState: 'normal' } });
      restoreWindow = async () => { try { await browserSession.send('Browser.setWindowBounds', { windowId, bounds }); } catch {} };
    }
    if (!/ele\.me$/i.test(new URL(page.url()).hostname)) await page.goto('https://h5.ele.me/msite/', { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForFunction(() => (document.body?.innerText || '').length > 20, null, { timeout: 20_000 }).catch(() => {});
    const body = await page.locator('body').innerText().catch(() => '');
    if (challenge(body)) throw new Error('页面出现安全验证。助手已停下，请你在专用 Chrome 里完成验证后再试。');
    if (/登录|立即登录/.test(body) && !/购物车/.test(body)) throw new Error('专用 Chrome 当前没有登录。请先在这个专用窗口登录外卖账号。');
    page.setDefaultTimeout(8_000);
    return { browser, context, page, restoreWindow };
  } catch (error) {
    await restoreWindow();
    await browser.close();
    throw error;
  }
}

async function openCart(page) {
  let text = await page.locator('body').innerText().catch(() => '');
  if (!/已选商品|清空购物车|提交订单/.test(text)) {
    if (!await clickText(page, /购物车/)) throw new Error(`没有找到购物车入口。页面：${normalize(text).slice(-700)}`);
    await page.waitForTimeout(700);
    text = await page.locator('body').innerText().catch(() => '');
  }
  return text;
}

function summarize(text, pageURL) {
  const lines = String(text).split(/\n+/).map(normalize).filter(Boolean);
  const end = lines.findIndex(line => /打包费|(?:实付|应付|合计|总计)/.test(line));
  const itemLines = end < 0 ? lines : lines.slice(0, end);
  const items = itemLines.filter(line => /(?:×|x)\s*\d+/.test(line) && line.length < 140).slice(0, 25);
  const textValue = String(text);
  const paidAmounts = [...textValue.matchAll(/(?:实付|应付)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/g)].map(match => Number(match[1]));
  let amounts = paidAmounts;
  if (!amounts.length) {
    const totalLines = [...textValue.matchAll(/(?:合计|总计)[^\n]{0,50}/g)].map(match => match[0]);
    amounts = totalLines.map(line => {
      const discounted = line.match(/已优惠\s*[¥￥]?\s*\d+(?:\.\d{1,2})?[\s\S]{0,12}?[¥￥]\s*(\d+(?:\.\d{1,2})?)/);
      const labeled = line.match(/(?:合计|总计)\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
      return Number(discounted?.[1] || labeled?.[1]);
    }).filter(Number.isFinite);
  }
  const distinctAmounts = [...new Set(amounts)];
  const address = lines.find(line => /桃李春风|如山|收货地址|单元|幢/.test(line)) || '';
  const shop = lines.find(line => /商家|店铺/.test(line)) || lines[0] || '淘宝闪购';
  const flattened = textValue.replace(/\s+/g, '').replace(/栋/g, '幢');
  const addressMatches = /桃李春风.{0,24}如山.{0,12}13幢.{0,8}2单元.{0,12}1210/.test(flattened);
  const hasAddressPicker = /请选择收货地址|选择收货地址|添加收货地址/.test(textValue);
  return { ok: items.length > 0 && distinctAmounts.length === 1 && addressMatches && !hasAddressPicker, shop, items, amount: distinctAmounts.length === 1 ? distinctAmounts[0] : null, address, page: pageURL, excerpt: lines.slice(-32).join('\n').slice(0, 2600) };
}

async function cartJob(input) {
  const { browser, page, restoreWindow } = await openPage();
  let submitAttempted = false;
  try {
    let text = await openCart(page);
    if (!/提交订单/.test(text)) {
      if (!/去结算|选好了|去下单|立即下单/.test(text)) throw new Error(`购物车没有可识别的结算按钮，未提交。页面摘要：${normalize(text).slice(-700)}`);
      if (!await clickText(page, /^(去结算|选好了|结算|去下单|立即下单)/)) throw new Error('没有找到购物车结算按钮，未提交。');
      await page.waitForFunction(() => /合计|实付|支付|提交订单/.test(document.body?.innerText || ''), null, { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(500);
      text = await page.locator('body').innerText().catch(() => '');
    }
    if (challenge(text)) throw new Error('结算时出现安全验证。助手已停下，未继续下单。');
    if (/请确认/.test(text)) {
      if (!await clickText(page, /^使用$/)) throw new Error('结算页要求确认地址，但没找到“使用”按钮。未提交订单。');
      await page.waitForTimeout(600);
      text = await page.locator('body').innerText().catch(() => '');
    }
    if (/请选择收货地址|选择收货地址|添加收货地址|请确认/.test(text)) throw new Error('结算页还没有明确选中收货地址。助手已停下，未提交订单。');
    const details = summarize(text, page.url());
    if (!details.ok) throw new Error(`没有同时核实购物车商品、唯一结算金额和已选收货地址。未提交订单。页面摘要：${normalize(text).slice(-600)}`);
    if (input.dry !== false) return { ...details, previewOnly: true, status: 'preview' };

    const paymentFile = process.env.LUMI_TAKEOUT_PAYMENT_FILE || join(homedir(), '.takeout_pay');
    let password = '';
    try { password = (await readFile(paymentFile, 'utf8')).trim(); } catch {}
    if (!password) throw new Error('本机没有付款口令；助手停在提交前，未下单。');
    const submit = page.locator('.submit-btn__button').first();
    if (!await submit.count() || !await submit.isVisible() || !await submit.isEnabled()) throw new Error('没有识别到可用的提交订单按钮，未提交。');
    submitAttempted = true;
    await submit.click({ timeout: 7_000 });
    await page.waitForTimeout(1_800);
    text = await page.locator('body').innerText().catch(() => '');
    if (challenge(text)) throw new Error('提交时出现安全验证。助手已停下；请先检查订单记录再重试。');
    let passwordBox = page.locator('input.my-passcode-input-native-input').first();
    if (!(await passwordBox.count()) && /确认付款/.test(text)) {
      if (!await clickText(page, /确认付款/)) throw new Error('没能识别付款确认按钮；请先检查订单记录再重试。');
      await page.waitForTimeout(600);
      passwordBox = page.locator('input.my-passcode-input-native-input').first();
    }
    if (await passwordBox.count()) await passwordBox.pressSequentially(password, { delay: 100 });
    else if (!/支付成功/.test(text)) throw new Error(`付款状态未能确认，请先检查订单记录。页面摘要：${normalize(text).slice(-500)}`);
    await page.waitForFunction(() => /支付成功/.test(document.body?.innerText || ''), null, { timeout: 25_000 }).catch(() => {});
    const finalText = await page.locator('body').innerText().catch(() => '');
    if (!/支付成功/.test(finalText)) throw new Error(`支付结果未确认，请先检查订单记录再重试。页面摘要：${normalize(finalText).slice(-500)}`);
    const orderID = (finalText.match(/订单号\s*(\d{8,})/) || [])[1] || null;
    const final = summarize(finalText, page.url());
    return { ...details, ok: true, paid: final.amount, paidAmountVerified: final.amount !== null, order: orderID, status: 'paid' };
  } catch (error) {
    if (submitAttempted) error.takeoutSubmitAttempted = true;
    throw error;
  } finally {
    await restoreWindow();
    await browser.close();
  }
}

async function runSearchOrder(input) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [orderScript, JSON.stringify(input)], { timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 });
    const output = stdout.trim().split(/\r?\n/).reverse().find(line => line.startsWith('{') && line.endsWith('}'));
    if (!output) throw new Error('外卖脚本没有返回订单结果。');
    return JSON.parse(output);
  } catch (error) {
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT';
    return { ok: false, stage: timedOut ? '订单状态待核实' : '本机外卖脚本', retryable: !timedOut, why: timedOut ? `外卖脚本运行超时；订单可能已提交。请先检查订单记录，不要重试。${String(error.message || error).slice(0, 500)}` : String(error.message || error).slice(0, 700) };
  }
}

async function runJob(job) {
  if (job.input?.cart === true) {
    try { return await cartJob(job.input); }
    catch (error) { return { ok: false, stage: error.takeoutSubmitAttempted ? '订单状态待核实' : '购物车结算', retryable: !error.takeoutSubmitAttempted, why: String(error.message || error).slice(0, 1000) }; }
  }
  return await runSearchOrder(job.input || {});
}

console.info(`Lumi 外卖助手已启动；API=${api}；Chrome=${cdp}`);
let delay = 1000;
while (true) {
  try {
    await apiRequest('/v1/takeout/bridge/heartbeat', { method: 'POST', body: '{}' });
    const { job } = await apiRequest('/v1/takeout/bridge/next', { timeout: 10_000 });
    if (!job) { await sleep(1500); delay = 1000; continue; }
    const result = await runJob(job);
    await apiRequest(`/v1/takeout/bridge/${encodeURIComponent(job.id)}/result`, { method: 'POST', body: JSON.stringify({ result }), timeout: 20_000 });
    delay = 1000;
  } catch (error) {
    console.error(`连接 Lumi 失败：${String(error.message || error).slice(0, 300)}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  }
}

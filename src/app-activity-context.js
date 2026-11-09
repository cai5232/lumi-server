function zone(value){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return value;}catch{return 'Asia/Shanghai';}}
function instant(value){if(typeof value==='number')value=value<1e12?value*1000:value;const ms=typeof value==='number'?value:Date.parse(value);return Number.isFinite(ms)?ms:null;}
const escaped=value=>String(value).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
export function appOpenTiming(input,now=Date.now()){
 const ms=instant(input.openedAt??input.timestamp??input.createdAt);const supplied=ms!==null&&ms<=now+5*60000&&ms>=now-7*86400000;
 return {createdAt:new Date(now).toISOString(),openedAt:supplied?new Date(ms).toISOString():null,timeSource:supplied?'shortcut':'received',timeZone:zone(input.timeZone||'Asia/Shanghai')};
}
export function formatAppActivity(events,{now=Date.now(),includeEmpty=false}={}){
 const recent=(Array.isArray(events)?events:[]).filter(e=>Number.isFinite(Date.parse(e.openedAt||e.createdAt))&&Date.parse(e.openedAt||e.createdAt)<=now).sort((a,b)=>Date.parse(b.openedAt||b.createdAt)-Date.parse(a.openedAt||a.createdAt)).slice(0,10);
 if(!recent.length)return includeEmpty?'最近的 10 次记录中没有 App 活动。':'';
 const lines=recent.map(e=>{const timeZone=zone(e.timeZone||'Asia/Shanghai');const time=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(e.openedAt||e.createdAt)).replace(/\//g,'-');return `- ${escaped(e.app)}（${e.openedAt?'打开于':'上报于'} ${time}，${timeZone}${e.openedAt?'':'；未提供精确打开时间'}）`;});
 return `最近 ${recent.length} 次自愿分享的 App 打开记录（从新到旧；上报时间不等同于精确打开时间，也不能据此推算使用时长）：\n${lines.join('\n')}`;
}

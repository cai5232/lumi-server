const instant=value=>{const ms=Date.parse(value||'');return Number.isFinite(ms)?ms:null;};
const iso=value=>value===null?null:new Date(value).toISOString();
const seconds=(end,start)=>start===null?null:Math.max(0,Math.floor((end-start)/1000));
const durationLabel=value=>{if(value===null)return null;let remaining=value;return [[86400,'天'],[3600,'小时'],[60,'分'],[1,'秒']].map(([unit,label])=>{const n=Math.floor(remaining/unit);remaining%=unit;return n?n+label:'';}).filter(Boolean).join('')||'0秒';};
const escaped=value=>JSON.stringify(value).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const visibleAssistant=message=>message.role==='assistant'&&['text','mixed','html','sentinel','sentinel_wake_dream','screen_peek','promise_alarm','sticker',''].includes(message.contentType||'')&&Boolean(String(message.content||'').trim()||message.htmlContent);
export function replySendTime(requestedAt,receivedAt){const received=instant(receivedAt)??Date.now();const sent=instant(requestedAt);const valid=sent!==null&&sent<=received&&sent>=received-7*86400000;return {at:iso(valid?sent:received),source:valid?'client_sent_at':'server_received_at',clockAdjusted:sent!==null&&!valid};}
export function buildReplyTiming({thread,now=Date.now(),request=null,proactive=false,failures=[]}){
 if(!proactive&&!request)return {content:'',data:null};
 const sent=request?replySendTime(request.requestedAt,request.receivedAt||iso(now)):null;
 const at=request?instant(sent.at):now;
 const messages=(thread?.messages||[]).filter(m=>!request?.userMessageID||m.id!==request.userMessageID).map(m=>({...m,at:instant(m.role==='user'?(m.clientSentAt||m.createdAt):m.createdAt)})).filter(m=>m.at!==null&&m.at<=at);
 const users=messages.filter(m=>m.role==='user').sort((a,b)=>a.at-b.at);const lastUser=users.at(-1)||null;
 // Answering or speaking in a real call is contact even when no chat bubble
 // was sent; technical call-status bubbles themselves do not start timers.
 const callContacts=(thread?.calls||[]).flatMap(call=>[...(call.startedAt?[instant(call.startedAt)]:[]),...(call.turns||[]).filter(turn=>turn.role==='user').map(turn=>instant(turn.createdAt))]).filter(ms=>ms!==null&&ms<=at);
 const lastCall=callContacts.length?Math.max(...callContacts):null;
 const lastContact=Math.max(lastUser?.at??-Infinity,lastCall??-Infinity);
 const assistants=messages.filter(visibleAssistant).sort((a,b)=>a.at-b.at);const latest=assistants.at(-1)||null;
 const unanswered=assistants.filter(m=>m.at>lastContact);
 const first=unanswered[0]||null;
 const attempts=failures.filter(e=>e.threadId===(thread?.id||'default')&&(e.kind||'chat')==='chat').map(e=>instant(e.requestedAt)||instant(e.failedAt)).filter(ms=>ms!==null&&ms<=at&&first&&ms>=first.at&&ms>lastContact);
 const attemptTimes=[...new Set(attempts)].sort((a,b)=>a-b);
 const zone=request?.timeZone||lastUser?.timeZone||'Asia/Shanghai';let timeZone;try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format();timeZone=zone;}catch{timeZone='Asia/Shanghai';}
 const data={mode:request?'user_message':'autonomous_wake',observedAt:iso(now),timeZone,
  latestAssistantMessageAt:iso(latest?.at??null),secondsSinceLatestAssistantMessage:seconds(at,latest?.at??null),
  latestUserMessageAt:iso(lastUser?.at??null),secondsSinceLatestUserMessage:seconds(at,lastUser?.at??null),
  latestCallContactAt:iso(lastCall),awaitingUserReply:Boolean(first),firstUnansweredAssistantAt:iso(first?.at??null),unansweredForSeconds:seconds(at,first?.at??null),unansweredAssistantMessages:unanswered.length,
  ...(request?{currentUserSentAt:sent.at,currentServerReceivedAt:request.receivedAt||iso(now),timingSource:sent.source,clockAdjusted:sent.clockAdjusted,isReplyToUnansweredMessage:Boolean(first)}:{}),
  knownFailedReplyAttempts:attemptTimes.length,firstFailedReplyAttemptAt:iso(attemptTimes[0]??null),latestFailedReplyAttemptAt:iso(attemptTimes.at(-1)??null),secondsSinceLatestFailedReplyAttempt:seconds(at,attemptTimes.at(-1)??null)};
 data.elapsedSinceAssistant=durationLabel(data.secondsSinceLatestAssistantMessage);data.elapsedSinceUser=durationLabel(data.secondsSinceLatestUserMessage);data.waitingForReply=durationLabel(data.unansweredForSeconds);data.elapsedSinceFailedAttempt=durationLabel(data.secondsSinceLatestFailedReplyAttempt);
 const explanation=request
  ? '这是本次真实用户发送的时间信息。secondsSinceLatestAssistantMessage 是她这次发送距你上一条可见消息的秒数；isReplyToUnansweredMessage=false 时是继续补充，不能说她刚才一直没回。多个主动消息的等待总时长从 firstUnansweredAssistantAt 起算，不会因你再次发消息而清零。'
  : '这是自主唤醒时的等待信息。secondsSinceLatestUserMessage 是距她上次聊天消息的秒数；只有 awaitingUserReply=true 才有尚未被回应的消息，unansweredForSeconds 从第一条未被回应的消息起算。awaitingUserReply=false 表示你没有还在等她回复的聊天消息，不要误说她一直不回你。';
 return {data,content:`<reply_timing source="server-calculated" data_only="true">\n${escaped(data)}\n${explanation}\nknownFailedReplyAttempts>0 表示她期间尝试发过消息但请求失败，不能当作没有尝试回复。latestCallContactAt 表示最近接听或通话中的交流；聊天间隔不等于没有联系。时间是发送/入库间隔，不是阅读耗时，也不能证明她何时看到、一直在线、故意不回或为何没回。你可以自然参考这些信息，无需机械播报或据此催促。\n</reply_timing>`};
}

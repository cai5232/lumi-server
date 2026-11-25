// 将渲染器已展开的 W=100 部件接到调节台的同一组几何函数。
import view from './view.cjs';

const pair = /(-?(?:\d+\.?\d*|\.\d+))[ ,]+(-?(?:\d+\.?\d*|\.\d+))/g;
const round = x => +x.toFixed(3);
const degrees = Math.PI / 180;

function angle(value, limit) {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || Math.abs(value) > limit)
    throw new RangeError('转角需要是 ±' + limit + '° 内的有限数字');
  return value;
}

function bounds(points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {x, y, width: Math.max(...xs)-x, height: Math.max(...ys)-y};
}

// 浏览器沿轮廓按弧长采样；Node 使用同一采样间距，曲线先由渲染器细分。
function sampleRing(points, count) {
  const ring = [...points, points[0]], lengths = [0];
  for (let i=1; i<ring.length; i++) lengths.push(lengths[i-1]+Math.hypot(ring[i][0]-ring[i-1][0],ring[i][1]-ring[i-1][1]));
  let j=1;
  return Array.from({length:count}, (_,i)=>{
    const distance=i*lengths.at(-1)/count;
    while (j<ring.length-1 && lengths[j]<=distance) j++;
    const t=(distance-lengths[j-1])/(lengths[j]-lengths[j-1] || 1);
    return ring[j].map((v,k)=>ring[j-1][k]+t*(v-ring[j-1][k]));
  });
}

function lowerEdge(points) {
  return x=>{
    let y=-Infinity;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length];
      if((a[0]<=x)!==(b[0]<=x)) y=Math.max(y,a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]));
    }
    return y;
  };
}

// 凸包，按顺序返回一圈点。两团努子合起来的外轮廓用它。
function hull(points) {
  const p=[...points].sort((m,n)=>m[0]-n[0]||m[1]-n[1]), cross=(o,m,n)=>(m[0]-o[0])*(n[1]-o[1])-(m[1]-o[1])*(n[0]-o[0]);
  const half=list=>{const out=[];for(const q of list){while(out.length>1&&cross(out.at(-2),out.at(-1),q)<=0)out.pop();out.push(q)}out.pop();return out};
  return [...half(p),...half([...p].reverse())];
}

// 沿 x=cx 把一圈轮廓切成左右两半（各自还是闭合的一圈）。
function halves(ring, cx) {
  const cut=keep=>{
    const out=[];
    for(let i=0;i<ring.length;i++){
      const a=ring[i], b=ring[(i+1)%ring.length], ina=keep(a[0]), inb=keep(b[0]);
      if(ina) out.push(a);
      if(ina!==inb){const t=(cx-a[0])/(b[0]-a[0]);out.push([cx,a[1]+t*(b[1]-a[1])]);}
    }
    return out;
  };
  return [cut(x=>x<=cx), cut(x=>x>=cx)];
}

function recolorShirt(color) {
  if(color?.toLowerCase?.()==='#fff4dc' || !/^#[\da-f]{6}$/i.test(color)) return view.shadowPaint.shirt;
  const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)), max=Math.max(...rgb);
  if(Math.min(...rgb)===max) return '#'+[max,Math.round(max*.91),Math.round(max*.74)].map(v=>v.toString(16).padStart(2,'0')).join('');
  return '#'+rgb.map(v=>Math.max(0,Math.round(max-(max-v)*1.9)).toString(16).padStart(2,'0')).join('');
}

// 只投影蛇下巴的 W 形分色线。两端越过头框，再由原头遮罩裁出脸颊。
function snakeJawBoundary(points, yaw, pitch) {
  const upper = lowerEdge(points.map(([x,y])=>[x,-y]));
  const seam = [];
  // 贴近轮廓时球面投影会折返。从脸颊内侧取切线，让颜色顺着弧度延伸到头遮罩以外。
  const inset = Math.min(14, 32 * (Math.abs(Math.sin(yaw)) + Math.abs(Math.sin(pitch))));
  for (let x = inset; x <= 100 - inset; x += .5) {
    const y = -upper(x);
    if (!Number.isFinite(y)) continue;
    const point = view.facePath('M'+x+' '+y, '浅色脸区', '', yaw, pitch);
    seam.push(point.slice(1).split(' ').map(Number));
  }
  function extend(end, inner, edgeX) {
    const slope = (end[1] - inner[1]) / (end[0] - inner[0]);
    const dx = edgeX - end[0];
    return [end[0] + dx / 2, end[1] + slope * dx / 2, edgeX, end[1] + slope * dx + .018 * dx * dx];
  }
  const left = extend(seam[0], seam[2], -10);
  const right = extend(seam.at(-1), seam.at(-3), 110);
  return 'M '+left.slice(2).join(' ')+' Q '+left.slice(0,2).join(' ')+' '+seam[0].join(' ')+
    ' L '+seam.slice(1).map(p=>p.join(' ')).join(' L ')+
    ' Q '+right.join(' ')+' L 110 150 L -10 150 Z';
}

function turnHead(doc, parts, shapeD, outline) {
  const yaw=angle(doc.view.yaw,40)*degrees, pitch=-angle(doc.view.pitch,24)*degrees;
  // 吻部底板：嘴努子2，猪是「猪鼻」，狐狸1 是「嘴努子颜色」；鼻子没有时用鼻孔定高度（牛、猪）。
  // 若若 11-23：「嘴努子都沿用试试？蛋蛋嘴我也很好奇效果」——所有吻部都用小熊那块梯形体积。
  const cap=parts.find(p=>p.name==='嘴努子2' || p.name==='猪鼻' || p.name==='嘴努子颜色'), nose=parts.find(p=>p.name==='鼻子') ?? parts.find(p=>/鼻孔$/.test(p.name));
  // 两团的蛋蛋嘴（猫、鼠、海豹）：两团合起来当一整块吻部算体积，每团各自鼓出来，中间的缝留着。
  const lobeParts=cap?[]:parts.filter(p=>/^(右|左)努子$/.test(p.name) && !p.hidden);
  let muzzle, muzzleBox, lobes=new Map();
  if((cap || lobeParts.length) && nose){
    const rim=cap?outline(cap):hull(lobeParts.flatMap(p=>outline(p))), box=bounds(rim), n=bounds(outline(nose));
    muzzleBox=box;
    const cx=box.x+box.width/2, cy=box.y+box.height/2;
    const samples=sampleRing(rim,96).map(([x,y])=>[x-cx,y-cy]);
    muzzle=view.muzzleVolume(box,samples,n.y+n.height/2-cy)(yaw,pitch);
    for(const p of lobeParts) lobes.set(p,muzzle.lobe(outline(p)));
    // 一整块但底边中间有缺口的（小兔、半垂耳小兔）：从中线切成两半，各鼓各的，缺口留着。
    const lower=lowerEdge(rim), centerBottom=lower(cx);
    if(cap && Number.isFinite(centerBottom) && box.y+box.height-centerBottom>box.height*.05)
      lobes.set(cap,halves(rim,cx).map(h=>muzzle.lobe(h)).join(' '));
  }
  // 近大远小：每只眼（眼底、高光、竖线一起）绕自己眼底投影后的中心整体缩放。
  const eyeCenter=new Map();
  for(const side of ['右','左']){
    const base=parts.find(p=>p.name===side+'眼底' && !p.hidden);
    if(!base) continue;
    const b=bounds(outline(base)), c=[b.x+b.width/2,b.y+b.height/2];
    const at=view.facePath('M'+c[0]+' '+c[1],'眼',base.name,yaw,pitch).slice(1).split(' ').map(Number);
    eyeCenter.set(side,{at,k:view.nearFar(c[0]>=50?1:-1,yaw)});
  }
  const snakeJaw=parts.some(p=>p.name==="前身") && parts.some(p=>p.name==="后身");
  const foxMask=parts.some(p=>p.name==='嘴边弧线');
  const faceClip=parts.find(p=>p.name==='头遮罩')?.name ?? parts.find(p=>p.name==='头')?.name;
  return parts.map(p=>{
    const ear=/耳/.test(p.name) && !/饰|耳机|遮罩/.test(p.name);
    // 两团的「右努子 / 左努子」（猫、鼠、海豹）、猪鼻、鼻孔也是口鼻，跟着吻部一起走，不然转头时会留在原地。
    const patch=p.name==='浅色脸区', mouth=!p.name.includes('面部阴影') && /嘴|鼻|人中|舌|努子/.test(p.name);
    if(!ear && !patch && !mouth && !/眼|睫毛|虹膜|眉|面部阴影|胡须/.test(p.name)) return p;
    if(p.hidden || p.type==='noise') return p;
    const pts=outline(p);
    if(!pts.length) return p;
    const box=bounds(pts), cx=box.x+box.width/2;
    const unit=patch?'浅色脸区':mouth?'口鼻':'眼';
    const project=d=>{
      if(ear) return view.earPath(d,cx>=50?1:-1,p.name.includes('内'),cx,yaw,pitch);
      if(muzzle && lobes.has(p)) return lobes.get(p);
      if(muzzle && p===cap) return muzzle.path;
      // 狐狸的嘴边弧线是吻部朝向那一侧的轮廓线（原来 facePath 也是往右转就翻到右边），贴着侧影最外面走。
      if(muzzle && p.name==='嘴边弧线') return d.replace(pair,(_,x,y)=>{
        const side=yaw>0?1:-1, wall=muzzle.wall(yaw>0?100-(+x):+x,+y);
        return wall.reduce((a,b)=>(b[0]-a[0])*side>0?b:a).map(round).join(' ');
      });
      // 比吻部还宽一圈的（斑海豹的「嘴周浅毛」）是脸上的毛色，不贴在吻部上。
      if(muzzle && mouth && box.width<=muzzleBox.width*1.2) return d.replace(pair,(_,x,y)=>muzzle.onFront(+x,+y).map(round).join(' '));
      const out=view.facePath(d,unit,p.name==='嘴边弧线'?'Ellipse 2':p.name,yaw,pitch);
      const eye=eyeCenter.get(p.name.match(/^(右|左)眼/)?.[1]);
      if(!eye || eye.k===1) return out;
      return out.replace(pair,(_,x,y)=>round(eye.at[0]+(x-eye.at[0])*eye.k)+' '+round(eye.at[1]+(y-eye.at[1])*eye.k));
    };
    // 圆角折线的 A 命令含半径和标志。先投影源顶点，再按原本的半径收圆。
    if(p.type==='line') return {...p,clip:p.clip??faceClip,pts:p.pts.map(([x,y,...r])=>[...project('M'+x+' '+y).slice(1).split(' ').map(Number),...r])};
    let d=p.type==='ellipse' || p.rotate ? 'M'+pts.map(q=>q.join(' ')).join(' L')+' Z' : shapeD(p);
    if(patch && foxMask && faceClip) {
      d=view.faceBoundary(yaw,pitch);
    } else if(patch && snakeJaw && faceClip) {
      if(yaw || pitch) d=snakeJawBoundary(pts,yaw,pitch);
    } else d=project(d);
    return {...p,type:'path',d,rotate:0,clip:ear?p.clip:p.clip??faceClip};
  });
}

function toWorld(doc,group) {
  const chain=[], seen=new Set();
  for(let id=group;id && doc.pose?.[id];id=doc.pose[id].parent){
    if(seen.has(id)) throw new Error('pose 组循环引用：'+id);
    seen.add(id);chain.push(doc.pose[id]);
  }
  let a=1,b=0,dx=0,dy=0;
  for(const g of chain){
    const t=(g.rotate??0)*degrees,c=Math.cos(t),s=Math.sin(t),x=g.cx??0,y=g.cy??0;
    [a,b]=[c*a-s*b,s*a+c*b];
    [dx,dy]=[c*(dx-x)-s*(dy-y)+x+(g.dx??0),s*(dx-x)+c*(dy-y)+y+(g.dy??0)];
  }
  return {apply:([x,y])=>[a*x-b*y+dx,b*x+a*y+dy],undo:([x,y])=>[a*(x-dx)+b*(y-dy),-b*(x-dx)+a*(y-dy)]};
}

// 盘蛇：前身外框固定。不同高度各有一个横截面，腹部与腹鳞贴着同一表面走。
function turnSnake(parts, front, yaw, outline) {
  if (!yaw) return parts;
  const ring = outline(front), box = bounds(ring), axis = box.x + box.width/2;
  const shell = [...ring,ring[0]].map(([x,y])=>({x,y}));
  const rad = yaw*degrees;
  function surface(x,y) {
    const [l,r] = view.shellSpan(box,shell,y), radius = Math.max(.01,(r-l)/2);
    const c = (r+l)/2, u = (x-c)/radius;
    const longitude = Math.asin(Math.max(-1,Math.min(1,u)))+rad;
    return c+radius*Math.sin(Math.max(-Math.PI/2,Math.min(Math.PI/2,longitude)));
  }
  // 正稿尾巴盘在右边。右转时先藏到腹后，再从另一侧露出来。
  const t = Math.min(1,Math.max(0,yaw/30));
  const scale = Math.cos(Math.PI*t);
  const lift = 6*Math.min(1,Math.abs(yaw)/30);
  const tailBox = bounds(outline(parts.find(p=>p.name==='后身')));
  const slope = -lift/Math.max(1,tailBox.x+tailBox.width-axis);
  const tailMatrix = [scale,slope,0,1,axis*(1-scale),-axis*slope];
  return parts.map(p=>{
    const clip = [].concat(p.clip??[]);
    if (['后身','后身遮罩'].includes(p.name) || clip.includes('后身遮罩'))
      return {...p,_surfaceMatrix:tailMatrix};
    if (p.name==='腹部') {
      const contour=outline(p);
      const d='M'+contour.map(([x,y])=>round(surface(x,y))+' '+round(y)).join(' L')+' Z';
      return {...p,type:'path',d,rotate:0};
    }
    if (clip.includes('腹部') && p.pts)
      return {...p,pts:p.pts.map(([x,y,...radius])=>[surface(x,y),y,...radius])};
    if (clip.includes('前身遮罩') && p.pts) {
      // 每枚鳞片保持圆角；用其中心所处的经度决定可见宽度。
      const b=bounds(outline(p)), x=b.x+b.width/2, y=b.y+b.height/2;
      const [l,r]=view.shellSpan(box,shell,y);
      if (x+b.width/2<l || x-b.width/2>r) return {...p,hidden:true};
      const k=Math.min(1.5,Math.max(0,(surface(x+.15,y)-surface(x-.15,y))/.3));
      return {...p,_surfaceMatrix:[k,0,0,1,surface(x,y)-k*x,0]};
    }
    return p;
  });
}

// 在 pose 摆好后，以骨盆为轴收放整条尾巴，尾尖、花纹和遮罩共用同一个变换。
function turnTail(doc, parts, shell, yaw, outline) {
  if (!yaw || !shell) return parts;
  const tail = parts.find(p => p.name === '尾巴') ??
    parts.find(p => p.name.startsWith('尾巴') && !p.hidden && p.type !== 'noise');
  if (!tail) return parts;
  const posedOutline = p => outline(p).map(toWorld(doc,p.group).apply);
  const torso = bounds(posedOutline(shell)), box = bounds(posedOutline(tail));
  const axis = torso.x + torso.width / 2;
  const offset = box.x + box.width / 2 - axis;
  // 藏在骨盆下的小圆尾只挪一点。卷尾和细长尾巴即使很小也要能翻面。
  const nearAxis = Math.abs(offset) <= torso.width * .12;
  const pom = (nearAxis || tail.type === 'ellipse' || tail.pts?.length === 4) &&
    Math.max(box.width,box.height) < torso.width * .30 &&
    Math.min(box.width,box.height) > Math.max(box.width,box.height) * .62 &&
    Math.abs(offset) + box.width / 2 <= torso.width / 2;
  const crossing = Math.max(0, Math.min(1, yaw * Math.sign(offset) / 30));
  const scale = pom ? 1 : Math.cos(Math.PI * crossing);
  const dx = pom ? -torso.width * .08 * Math.sin(yaw * degrees) : 0;
  const matrix = [scale,0,0,1,axis*(1-scale)+dx,0];
  if (scale === 1 && dx === 0) return parts;
  const isTail = name => name.startsWith('尾巴') || name.endsWith('尾尖');
  return parts.map(p => isTail(p.name) || (p.clip && [].concat(p.clip).every(isTail))
    ? {...p, _tailMatrix:matrix} : p);
}

function shadeBody(doc,parts,outline) {
  const yaw=angle(doc.bodyView.yaw,40);
  angle(doc.bodyView.pitch,24);
  const front=parts.find(p=>p.name==='前身');
  if(front && parts.some(p=>p.name==='后身') && parts.some(p=>p.name==='腹部'))
    return turnSnake(parts,front,yaw,outline);
  const shell=parts.find(p=>p.name==='衣服主体')??parts.find(p=>p.name==='身体');
  parts=turnTail(doc,parts,shell,yaw,outline);
  const head=parts.find(p=>p.name==='头');
  if(!shell || !head) return parts;
  const shellFrame=toWorld(doc,shell.group), headFrame=toWorld(doc,head.group);
  const ring=outline(shell), box=bounds(ring), chin=lowerEdge(outline(head).map(headFrame.apply).map(shellFrame.undo));
  const xy=[...ring,ring[0]].map(([x,y])=>({x,y}));
  const shadow=view.bodyShadow(yaw,box,y=>view.shellSpan(box,xy,y),x=>Number.isFinite(chin(x))?chin(x):box.y);
  function layer(p,suffix,d,leg=false) {
    return {type:'path',name:p.name+suffix,d,clip:p.name,...view.shadowPaint[leg?'leg':'cloth'],blend:view.shadowPaint.mode,group:p.group};
  }
  const shirt=parts.find(p=>p.name==='衬衫');
  const shellIndex=parts.indexOf(shell);
  let fabricEnd=shellIndex;
  while(fabricEnd+1<parts.length && /^(衬衫|衣领|衣襟)/.test(parts[fabricEnd+1].name)) fabricEnd++;
  return parts.flatMap((p,i)=>{
    if(i===fabricEnd){
      const out=[p];
      out.push({...layer(shell,'转身与下巴影',shadow.head),_shadowPaths:[shadow.side,shadow.head].filter(Boolean)});
      if(shirt) out.push({...layer(shirt,'受光暖色',shadow.head),fill:recolorShirt(shirt.fill),blend:undefined,opacity:1});
      return out;
    }
    if(!/^(左腿|右腿|腿左|腿右)$/.test(p.name)) return [p];
    const b=bounds(outline(p)), band=view.legBand(yaw,b), out=[p];
    const paths=band?[band]:[];
    if(view.castsHem(doc.action?.type==='坐下',i<shellIndex)){
      const legFrame=toWorld(doc,p.group);
      const hem=lowerEdge(ring.map(shellFrame.apply).map(legFrame.undo));
      const xa=b.x-3,xb=b.x+b.width+3;
      const d=view.hemShadow(xa,xb,b.y,(x,y)=>[x,y],x=>Number.isFinite(hem(x))?hem(x):b.y-25);
      paths.push(d);
    }
    if(paths.length) out.push({...layer(p,'圆柱与衣摆影',paths[0],true),_shadowPaths:paths});
    return out;
  });
}

// 小鸟转身（若若 11-24 定稿）。小鸟头身一整块（「像葫芦」），参考橡皮鸭转身：
// - 五官、花色块：按小鸟头轮廓逐行量左右边，按这一行自己的半宽做经度转（同盘蛇），什么形状都贴得住；轮廓外的点不动。
// - 眼睛近大远小（同转头）。头顶往脸朝的方向探一点，腰以下不动。
// - 翅膀长在侧面，只跟着转一半；画在轮廓外的那截保持和边的距离。
// - 鸟嘴往外伸：正面照原稿（正面是美化过的垂嘴），越转越平伸，40° 时朝脸向、下斜 25°、长 +4；转身时不裁进头。
// - 尾巴：朝向哪边尾巴在另一边。往尾巴那侧转时先藏到正后方再镜像换边，形状不压扁。
// 小鸟没有身体，view 和 bodyView 都按这一套转；两个都写时用 bodyView。只转左右，pitch 不用。
const isBird=parts=>parts.some(p=>p.name==='头') && parts.some(p=>p.name==='鸟嘴') && !parts.some(p=>p.name==='身体' || p.name==='衣服主体');
function turnBird(doc,parts,outline){
  const yawDeg=angle((doc.bodyView??doc.view).yaw,40), yaw=yawDeg*degrees;
  if(!yaw) return parts;
  const head=parts.find(p=>p.name==='头'), ring=outline(head), box=bounds(ring), xy=[...ring,ring[0]].map(([x,y])=>({x,y}));
  const span=y=>view.shellSpan(box,xy,y), mid=box.x+box.width/2;
  const rowTurn=(x,y,rate=1)=>{
    const [l,r]=span(y), c=(l+r)/2, R=(r-l)/2;
    if(R<1 || x<=l || x>=r) return x;
    return c+R*Math.sin(Math.max(-Math.PI/2,Math.min(Math.PI/2,Math.asin((x-c)/R)+yaw*rate)));
  };
  const wingX=(x,y)=>{
    const [l,r]=span(y), c=(l+r)/2, R=(r-l)/2, over=x<l?x-l:x>r?x-r:0;
    if(R<1) return x;
    const s=Math.max(-1,Math.min(1,(x-over-c)/R));   // 轮廓外那截按边上的点转，再把超出的距离加回去
    return c+R*Math.sin(Math.max(-Math.PI/2,Math.min(Math.PI/2,Math.asin(s)+yaw*.5)))+over;
  };
  const LEAN=5, lean=(x,y)=>x+LEAN*Math.sin(yaw)*Math.min(1,Math.max(0,(50-y)/50));   // 头顶最多探 5，y 50（腰）以下不动
  // 眼睛：整只眼（眼底+高光）绕眼底中心缩放
  const eyes={};
  for(const side of ['右','左']){
    const b=parts.find(p=>p.name===side+'眼底'); if(!b) continue;
    const e=bounds(outline(b)), cx=e.x+e.width/2, cy=e.y+e.height/2;
    eyes[side]={at:lean(rowTurn(cx,cy),cy),k:view.nearFar(cx>=mid?1:-1,yaw),cy};
  }
  // 尾巴：名字以「尾」开头的部件一起走；尾根取最靠身体中线的那个点
  const tails=parts.filter(p=>/^尾/.test(p.name) && p.pts);
  let tailFx=null;
  if(tails.length){
    const pts=tails.flatMap(p=>p.pts), side=Math.sign(pts.reduce((s,q)=>s+q[0],0)/pts.length-mid)||1;
    const near=[...pts].sort((a,b)=>Math.abs(a[0]-mid)-Math.abs(b[0]-mid)).slice(0,2), rx=(near[0][0]+near.at(-1)[0])/2;   // 尾根 = 最靠中线的两个点的中点
    const d=yawDeg*side, TH0=60, K=3;   // 正面看尾巴朝侧后 60°；往尾巴那侧转 20° 藏到正后方，40° 换到另一边
    const m=d<=0?1:Math.max(-1,Math.min(1,Math.sin((TH0-K*d)*degrees)/Math.sin(TH0*degrees)));
    const target=d<=0?rx+side*4*Math.sin(-d*degrees):mid+(rx-mid)*m, flip=m<0;
    tailFx=p=>{let q=p.pts.map(([x,y,...r])=>[round(target+(flip?rx-x:x-rx)),y,...r]); if(flip) q=q.reverse(); return {...p,pts:q};};
  }
  // 头顶呆毛：跟着头顶中点平移
  const topY=box.y+6, crestDx=lean(rowTurn(mid,topY),topY)-mid;
  const BEAK_DOWN=25*degrees, BEAK_EXTRA=4;
  const turnBeak=p=>{
    const ys=p.pts.map(q=>q[1]), y0=Math.min(...ys), Lf=Math.max(...ys)-y0, bx=p.pts.reduce((s,q)=>s+q[0],0)/p.pts.length;
    const root=[lean(rowTurn(bx,y0),y0),y0];
    const t=Math.min(1,Math.abs(Math.sin(yaw))/Math.sin(40*degrees)), side=Math.sign(yaw), Ls=Lf+BEAK_EXTRA;
    const tip=[side*Ls*Math.cos(BEAK_DOWN)*t, Lf*(1-t)+Ls*Math.sin(BEAK_DOWN)*t];
    const len=Math.hypot(...tip), n=[tip[1]/len,-tip[0]/len];
    const {clip,...rest}=p;
    return {...rest,pts:p.pts.map(([x,y,...r])=>{const a=(y-y0)/Lf, c=x-bx; return [round(root[0]+tip[0]*a+n[0]*c),round(root[1]+tip[1]*a+n[1]*c),...r];})};
  };
  return parts.map(p=>{
    if(tailFx && /^尾/.test(p.name) && p.pts) return tailFx(p);
    if(/^腿|腿$/.test(p.name)) return p;
    if(p.name==='鸟嘴' && p.pts) return turnBeak(p);
    if(p.name==='头') return {...p,pts:p.pts.map(([x,y,...r])=>[round(lean(x,y)),y,...r])};
    if(/呆毛|头顶羽毛/.test(p.name) && !p.clip){
      const move=(x,y)=>[round(x+crestDx),y];
      if(p.pts) return {...p,pts:p.pts.map(([x,y,...r])=>[...move(x,y),...r])};
      if(p.d) return {...p,d:p.d.replace(pair,(_,x,y)=>move(+x,+y).join(' '))};
      return p;
    }
    const eye=eyes[p.name.match(/^(右|左)眼/)?.[1]], wing=/翅膀/.test(p.name);
    const f=(x,y)=>{let X=lean(wing?wingX(x,y):rowTurn(x,y),y); if(eye) X=eye.at+(X-eye.at)*eye.k; return round(X);};
    const g=y=>eye?round(eye.cy+(y-eye.cy)*eye.k):y;
    if(p.pts) return {...p,pts:p.pts.map(([x,y,...r])=>[f(x,y),g(y),...r])};
    if(p.d) return {...p,d:p.d.replace(pair,(_,x,y)=>f(+x,+y)+' '+g(+y))};
    if(p.type==='ellipse') return {...p,cx:f(p.cx,p.cy)};
    return p;
  });
}

export function applyViews(doc,parts,shapeD,outline){
  if(isBird(parts)) return turnBird(doc,parts,outline);
  if(doc.bodyView) parts=shadeBody(doc,parts,outline);
  if(doc.view) parts=turnHead(doc,parts,shapeD,outline);
  return parts;
}


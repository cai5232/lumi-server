// 兼容浏览器经典脚本与 Node CommonJS 的共享几何模块（单一实现）。
(function(root, factory) {
 const api=factory();
 if(typeof module==='object' && module.exports) module.exports=api;
 else root.ChibiView=api;
})(globalThis, function(){
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)), round=v=>Math.round(v*1000)/1000;
const pair=/(-?(?:\d+\.?\d*|\.\d+))[ ,]+(-?(?:\d+\.?\d*|\.\d+))/g;
function line(points){return points.map((p,i)=>(i?'L':'M')+p.map(round).join(' ')).join(' ')}
function posePoint(x,y,yaw,pitch,relief){
 const u=x-50,v=y-42;
 // 头是一个柔和的类球体：上极点正好在头顶 (50,0)，所以转头时经线都从头顶出发；
 // 往下巴那半边更扁一点。指数 2.4 比正球方一点，脸前面更平、到两侧才收。
 // 五官都贴在同一个面上，只有口鼻往外再凸出 relief-36。
 const A=50,B=v<0?42:40,C=35.5,P=2.4;
 const rest=Math.max(0,1-Math.abs(u/A)**P-Math.abs(v/B)**P);
 const depth=C*rest**(1/P)+Math.max(0,relief-36);
 const turnedDepth=depth*Math.cos(yaw)-u*Math.sin(yaw);
 return [50+u*Math.cos(yaw)+depth*Math.sin(yaw),
         42+v*Math.cos(pitch)+turnedDepth*Math.sin(pitch)];
}
function earPoint(x,y,side,yaw,pitch){
 const rootX=50+side*29,rootY=15;
 const dx=x-rootX,dy=y-rootY;
 const far=side*Math.sin(yaw);
 // The roots sit behind the face. An outward-facing ear presents a narrower opening on the far side.
 const width=Math.cos(yaw)-.36*far;
 const anchorX=50+(rootX-50)*Math.cos(yaw)-8*Math.sin(yaw);
 const depth=-8*Math.cos(yaw)-(rootX-50)*Math.sin(yaw);
 const anchorY=42+(rootY-42)*Math.cos(pitch)+depth*Math.sin(pitch)+Math.max(0,far)*5;
 return [anchorX+dx*width+dy*.12*Math.sin(yaw),
         anchorY+dy*(1-.14*Math.max(0,far))*Math.cos(pitch)+dy*.18*Math.sin(pitch)-dx*Math.sin(yaw)*Math.sin(pitch)];
}
function smoothHull(points){
 const p=[...points].sort((m,n)=>m[0]-n[0]||m[1]-n[1]),cross=(o,m,n)=>(m[0]-o[0])*(n[1]-o[1])-(m[1]-o[1])*(n[0]-o[0]);
 const half=list=>{const out=[];for(const q of list){while(out.length>1&&cross(out[out.length-2],out[out.length-1],q)<=0)out.pop();out.push(q)}out.pop();return out};
 const hull=[...half(p),...half(p.reverse())],n=hull.length;
 // 顶点之间用中点二次曲线连接，外轮廓保持圆润。
 const mid=i=>{const m=hull[i%n],q=hull[(i+1)%n];return [(m[0]+q[0])/2,(m[1]+q[1])/2]};
 let d='M'+mid(0).map(round).join(' ');
 for(let i=1;i<=n;i++)d+=' Q'+hull[i%n].map(round).join(' ')+' '+mid(i).map(round).join(' ');
 return d+' Z';
}
function shellSpan(shellBox,shellRing,y){const level=clamp(y,shellBox.y+.05,shellBox.y+shellBox.height-.05),xs=[];for(let i=1;i<shellRing.length;i++){const a=shellRing[i-1],b=shellRing[i];if((a.y<=level)!=(b.y<=level))xs.push(a.x+(b.x-a.x)*(level-a.y)/(b.y-a.y))}return xs.length?[Math.min(...xs),Math.max(...xs)]:[50,50]}
function cylinderPoint(x,y,state,shellBox,span){
 const yaw=state.body.yaw*Math.PI/180,pitch=state.body.pitch*Math.PI/180,[l,r]=span(y),c=(l+r)/2,R=Math.max(.1,(r-l)/2),u=x-c;
 const v=clamp((y-(shellBox.y+shellBox.height/2))/(shellBox.height/2),-1,1),P=4;
 const depth=.75*Math.sqrt(Math.max(0,R*R-u*u))*(1-Math.abs(v)**P)**(1/P);
 const turnedDepth=depth*Math.cos(yaw)-u*Math.sin(yaw);
 return [c+u*Math.cos(yaw)+depth*Math.sin(yaw), y-turnedDepth*Math.sin(pitch)];
}
function muzzleVolume(box,rim,noseY){
 const cx=box.x+box.width/2,cy=box.y+box.height/2,a=box.width/2,b=box.height/2,h=a*.85;
 const rimRadius=angle=>{let best=rim[0],gap=Infinity;for(const p of rim){const d=Math.abs(Math.atan2(Math.sin(Math.atan2(p[1],p[0])-angle),Math.cos(Math.atan2(p[1],p[0])-angle)));if(d<gap){gap=d;best=p}}return Math.hypot(...best)};
 const levels=Array.from({length:9},(_,k)=>k*Math.PI/16);
 // 侧面是直角梯形：顶边从脸上平伸到鼻子，前脸竖直，下巴斜着收回脸上。
 // 所以鼻子那一排最突出，越往下巴越浅。
 const depthAt=Y=>h*(Y<=noseY?1:1-.55*clamp((Y-noseY)/(b-noseY),0,1));
 // 前脸和侧壁之间的圆角：往里收 round_ 的半径，占深度的 edge。
 const round_=.28,edge=.45;
 // 底边贴着头的球面，离中心越远越往后退一点。
 const sink=(X,Y)=>-(X*X+Y*Y)/(2*57);
 const turn=(yaw,pitch)=>{
  const c=Math.cos(yaw),s=Math.sin(yaw),t=Math.sin(pitch),v=Math.cos(pitch);
  const [ax,ay]=posePoint(cx,cy,yaw,pitch,36);
  const view=(X,Y,Z)=>[ax+X*c+Z*s, ay+Y*v+(Z*c-X*s)*t];
  const dome=[];
  for(const [X,Y] of rim){
   const base=sink(X,Y),D=depthAt(Y);
   for(const w of [0,.5,1])dome.push(view(X,Y,base+(D-edge*D)*w));
   for(const f of levels){const k=1-round_*(1-Math.cos(f));dome.push(view(X*k,Y*k,base+D-edge*D+edge*D*Math.sin(f)))}
  }
  const path=smoothHull(dome);
  // 鼻子和嘴线贴在前脸上；靠边的点落在前脸转向侧壁的圆角上。
  const onFront=(x,y)=>{
   const X=x-cx,Y=y-cy,r=Math.min(1,Math.hypot(X,Y)/rimRadius(Math.atan2(Y,X))),D=depthAt(Y);
   const lift=r<=1-round_?1:Math.sqrt(Math.max(0,1-((r-1+round_)/round_)**2));
   return view(X,Y,sink(X,Y)+D-edge*D+edge*D*lift);
  };
  // 轮廓上一点从脸面到前脸那一圈侧壁上的投影点（和 dome 同样的采样）：狐狸嘴边弧线取最外面那个，贴着侧影走。
  const wall=(x,y)=>{
   const X=x-cx,Y=y-cy,base=sink(X,Y),D=depthAt(Y),out=[];
   for(const w of [0,.5,1])out.push(view(X,Y,base+(D-edge*D)*w));
   for(const f of levels){const k=1-round_*(1-Math.cos(f));out.push(view(X*k,Y*k,base+D-edge*D+edge*D*Math.sin(f)))}
   return out;
  };
  // 两团的蛋蛋嘴：整个吻部还是一块梯形体积，每一团按自己的轮廓贴在上面往前鼓，圆角往这一团自己的中心收，中间的缝留着。
  const lobe=points=>{
   const lx=points.reduce((s,p)=>s+p[0],0)/points.length-cx,ly=points.reduce((s,p)=>s+p[1],0)/points.length-cy,out=[];
   for(const [x,y] of points){
    const X=x-cx,Y=y-cy,base=sink(X,Y),D=depthAt(Y);
    for(const w of [0,.5,1])out.push(view(X,Y,base+(D-edge*D)*w));
    for(const f of levels){const k=1-round_*(1-Math.cos(f));out.push(view(lx+(X-lx)*k,ly+(Y-ly)*k,base+D-edge*D+edge*D*Math.sin(f)))}
   }
   return smoothHull(out);
  };
  return {path,onFront,wall,lobe};
 };
 turn.lift=(x,y)=>{
  const X=x-cx,Y=y-cy,r=Math.hypot(X,Y)/rimRadius(Math.atan2(Y,X));
  if(r>=1)return 0;const D=depthAt(Y);
  const lift=r<=1-round_?1:Math.sqrt(Math.max(0,1-((r-1+round_)/round_)**2));
  return Math.max(0,D-edge*D+edge*D*lift);
 };
 return turn;
}
function bodyShadow(yawDeg,shellBox,span,chinAt){
 const yaw=yawDeg*Math.PI/180,top=shellBox.y,h=shellBox.height,ys=Array.from({length:25},(_,i)=>top-2+i*(h+4)/24);
 // 只在转身后变宽的那一侧加暗面：往右转（正角度）时我们视角的左边变宽，反过来就是右边。正面不加两侧。
 const yawSide=Math.abs(yawDeg)<1?0:-Math.sign(yawDeg);
 // 暗面是转过来露出的那块侧面：转得越多露得越多，内边界在屏幕上从轮廓边往中间推，转 40° 时到半宽左右。
 const sideBand=side=>{const k=.42*Math.min(1,Math.abs(yaw)/(40*Math.PI/180)),t=Math.asin(side*(1-2*k));
  const inner=ys.map(y=>{const [l,r]=span(y),c=(l+r)/2,R=(r-l)/2;return [c+R*Math.sin(t),y]});
  const outer=ys.map(y=>[side>0?shellBox.x+shellBox.width+8:shellBox.x-8,y]).reverse();
  return line([...inner,...outer])+' Z'};
 const hc=shellBox.x+shellBox.width/2,hw=shellBox.width/2+4;
 const arc=Array.from({length:33},(_,i)=>{const u=-1+i/16,x=hc+u*hw;return [x,Math.min(chinAt(x),top+8)+1+5.5*(1-Math.abs(u)**1.4)]});
 return {side:yawSide?sideBand(yawSide):'',head:line([[hc-hw,top-8],...arc,[hc+hw,top-8]])+' Z'};
}
function legBand(yawDeg,b){
 const yaw=yawDeg*Math.PI/180,yawSide=Math.abs(yawDeg)<1?0:-Math.sign(yawDeg);
 const k=.38*Math.min(1,Math.abs(yaw)/(40*Math.PI/180));
 if(yawSide){const x0=yawSide<0?b.x-2:b.x+b.width*(1-k),x1=yawSide<0?b.x+b.width*k:b.x+b.width+2;
  return `M${round(x0)} ${round(b.y-2)}H${round(x1)}V${round(b.y+b.height+2)}H${round(x0)}Z`}
 else return '';
}
function castsHem(seated,behind){return behind && !seated}
function hemShadow(xa,xb,top,toLocal,hemY){
 const pts=Array.from({length:17},(_,i)=>{const x=xa+i*(xb-xa)/16;return toLocal(x,hemY(x)+2.2)});
 return line([toLocal(xa,top-20),...pts,toLocal(xb,top-20)])+' Z';
}
function facePath(source,unit,part,angle,pitch){
 const guideY=42,anchor=posePoint(50,guideY,angle,pitch,36),patch=unit==='浅色脸区';
   const relief=unit==='口鼻'?44:unit==='眉毛'?31:patch?34:36;
   const shape=source.replace(pair,(_,px,py)=>{
    let x=Number(px),y=Number(py);
    if(part==='Ellipse 2' && angle>0)x=100-x;
    let [xx,yy]=posePoint(x,y,angle,pitch,relief);
    let height=unit==='口鼻'?anchor[1]+(y-guideY)*Math.cos(pitch):yy;
    if(patch){
     // 浅色脸区的分界和眼睛长在同一层脸面上；吻部底下那一段是吻部下沿，
     // 跟着嘴努子一起凸出来，往两颊慢慢过渡回脸面。
     const face=posePoint(x,y,angle,pitch,36),snout=posePoint(x,y,angle,pitch,44);
     const snoutY=anchor[1]+(y-guideY)*Math.cos(pitch);
     const w=Math.cos(Math.min(1,Math.abs(x-50)/16)*Math.PI/2)**2;
     xx=face[0]+(snout[0]-face[0])*w; height=face[1]+(snoutY-face[1])*w;
    }
    return round(xx)+' '+round(height);
   });
 return shape;
}
// 近大远小（若若 IMG_5818「和人眼一样近大远小」）：眼睛除了被球面挤窄，近的那只整体放大、远的那只整体缩小，高度也跟着变。
// side：眼在正面时的位置，右半边 1、左半边 -1。向右转（yaw>0）时右半边的眼转到远处。
const NEAR_FAR=.15;
function nearFar(side,yaw){return 1-NEAR_FAR*side*Math.sin(yaw)}
function earPath(d,side,inner,cx,angle,pitch){
 return d.replace(pair,(_,x,y)=>{
   const u=inner?cx+(+x-cx)*(1-.52*Math.abs(Math.sin(angle)))+9*Math.sin(angle):+x;
   return earPoint(u,+y,side,angle,pitch).map(round).join(' ');
 });
}
function faceBoundary(yaw,pitch){
 return facePath('M -38 58 C -13 59 4 45 20 46 C 31 45 40 53 50 53 C 61 53 70 45 81 46 C 96 45 111 59 138 58','浅色脸区','',yaw,pitch)+' L 160 140 L -60 140 Z';
}
const shadowPaint={
  cloth:{fill:'#e6bcc8',opacity:.5},leg:{fill:'#eebb8f',opacity:.32},
  shirt:'#ffe7bd',mode:'color-burn'
};
return {nearFar,castsHem,shadowPaint,posePoint,earPath,facePath,faceBoundary,muzzleVolume,shellSpan,cylinderPoint,bodyShadow,legBand,hemShadow};
});

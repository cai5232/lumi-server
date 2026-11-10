import './mock-model-fetch.js';
const realFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'?input:input.url);
 if(url.hostname==='ephemera-date.107.174.137.23.sslip.io'&&process.env.LUMI_TEST_EPHEMERA_TARGET)return realFetch(new URL(url.pathname+url.search,process.env.LUMI_TEST_EPHEMERA_TARGET).href,init);
 return realFetch(input,init);
};

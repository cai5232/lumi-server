import {test} from 'node:test';
import assert from 'node:assert/strict';
import {responseThinking} from '../src/response-thinking.js';
test('preserves supplied native and compatible model reasoning, never invents it',()=>{
 assert.equal(responseThinking({content:[{type:'thinking',thinking:'真实心声'},{type:'text',text:'正文'}]}),'真实心声');
 assert.equal(responseThinking({choices:[{message:{content:'正文',reasoning_content:'另一路心声'}}]}),'另一路心声');
 assert.equal(responseThinking({choices:[{message:{content:'正文'}}]}),'');
 assert.equal(responseThinking({choices:[{message:{content:[{type:'reasoning',text:'分块心声'},{type:'text',text:'正文'}]}}]}),'分块心声');
});

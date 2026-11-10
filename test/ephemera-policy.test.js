import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isTrustedEphemera,ephemeraWriteAllowed,ephemeraTrace,sealEphemeraReply,EPHEMERA_MCP_URL} from '../src/ephemera-policy.js';
const server={id:'ephemera-date',url:EPHEMERA_MCP_URL};
test('date writes are scoped to the exact server and registered date tools',()=>{
 assert.ok(ephemeraWriteAllowed(server,{name:'date_edit'}));assert.ok(ephemeraWriteAllowed(server,{name:'date_send'}));
 for(const candidate of [{...server,id:'other'},{...server,url:EPHEMERA_MCP_URL+'?redirect=1'},{...server,url:'https://other.example/mcp'}])assert.equal(isTrustedEphemera(candidate),false);
 assert.equal(ephemeraWriteAllowed(server,{name:'exec_shell'}),false);
});
test('date trace including failed calls masks private itinerary and seals thinking',()=>{
 for(const succeeded of [true,false]){
 const trace=ephemeraTrace({server},{name:'date_edit',arguments:'secret place',result:'secret note',succeeded});
 assert.ok(trace.ephemeraSealed);assert.equal(JSON.stringify(trace).includes('secret'),false);
 assert.equal(sealEphemeraReply('<thinking>secret itinerary</thinking>去拆信吧','secret reasoning',[trace]),'去拆信吧');
 }
 const trace={name:'flowers_menu',arguments:'{}',result:'rose',succeeded:true};assert.equal(ephemeraTrace({server:{id:'flowers'}},trace),trace);
 assert.match(sealEphemeraReply('hello','thought',[trace]),/thought/);
});

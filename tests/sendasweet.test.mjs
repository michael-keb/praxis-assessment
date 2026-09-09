import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {createSendASweetRouter} from '../server/sendasweet.js';
const root=path.resolve(import.meta.dirname,'../static/sendasweet');
let server,origin;
before(async()=>{
 const app=express();app.use('/sendasweet',createSendASweetRouter(root));
 app.get('*',(_req,res)=>res.send('assessment app'));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 origin=`http://127.0.0.1:${server.address().port}`;
});
after(()=>new Promise(resolve=>server.close(resolve)));
for(const route of ['', '/', '/makers/cocoa-and-crumb', '/makers/butter-and-fold/', '/makers/sunday-sweet']){
 test(`Send a Sweet HTML loads at ${route||'root'}`,async()=>{
  const res=await fetch(`${origin}/sendasweet${route}`);assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/<title>.*Send a Sweet/);
  assert.match(html,/\/sendasweet\/images\//);assert.doesNotMatch(html,/src="\/(?:images|_next)\//);
 });
}
test('Every local HTML asset and all store links resolve inside /sendasweet',async()=>{
 const html=await (await fetch(`${origin}/sendasweet`)).text();
 const urls=new Set([...html.matchAll(/(?:href|src)="(\/sendasweet[^"#]*)"/g)].map(m=>m[1].replaceAll('&amp;','&')));
 assert.ok(urls.size>10);
 for(const url of urls){const res=await fetch(origin+url);assert.equal(res.status,200,url);}
 for(const slug of ['cocoa-and-crumb','butter-and-fold','sunday-sweet'])assert.ok(html.includes(`/sendasweet/makers/${slug}`),slug);
});
test('Client-side navigation receives an RSC payload, not HTML',async()=>{
 for(const slug of ['cocoa-and-crumb','butter-and-fold','sunday-sweet']){
 const res=await fetch(`${origin}/sendasweet/makers/${slug}/?_rsc=test`,{headers:{RSC:'1'}});
 assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/x-component/);
 assert.match(res.headers.get('vary'),/RSC/);assert.equal(res.headers.get('cache-control'),'no-store');
 assert.doesNotMatch(await res.text(),/^<!doctype/i);
 }
});
test('Unknown sweets URLs stay 404 and the assessment application stays separate',async()=>{
 for(const route of ['/sendasweet/makers/missing','/sendasweet/images/missing.webp']){
 const res=await fetch(origin+route);assert.equal(res.status,404);assert.doesNotMatch(await res.text(),/assessment app/);
 }
 for(const route of ['/','/auth','/assess?case=test'])assert.equal(await(await fetch(origin+route)).text(),'assessment app');
});
test('Exported image and code files exist and no server files are shipped',()=>{
 assert.ok(fs.existsSync(path.join(root,'images/chocolate-hero.webp')));
 assert.ok(fs.existsSync(path.join(root,'_next/static')));
 assert.ok(!fs.existsSync(path.join(root,'server')));
});

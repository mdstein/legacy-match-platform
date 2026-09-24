// Source images are Valve's installed legacy CS:GO inventory artwork. Produce
// small immutable PNGs for on-demand launcher download; no archive ships.
import { createHash } from "node:crypto";
import { mkdir,readFile,writeFile,unlink } from "node:fs/promises";
import { resolve,join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { readKeyValues,readVpk } from "./lib/read-valve-assets.mjs";
import { B2G_CASES,B2G_PIN_PACKAGES,B2G_SOUVENIR_PACKAGES,B2G_SPECIAL_REWARDS,B2G_GRAFFITI } from "../packages/db/src/drop-catalog.ts";

const root=resolve(import.meta.dirname,"..");
const game=resolve(process.argv[2]??join(root,".tools/csgo-server/csgo"));
const schemaPath=join(game,"scripts/items/items_game.txt");
const schema=(await readKeyValues(schemaPath)).get("items_game");
const vpk=await readVpk(join(game,"pak01_dir.vpk"));
const out=join(root,"apps/web/public/trading-items");await mkdir(out,{recursive:true});
const previous=await readFile(join(out,"PROVENANCE.json"),"utf8").then(JSON.parse).catch(error=>{if(error.code==="ENOENT")return {files:{}};throw error;});
const schemaHash=createHash("sha256").update(await readFile(schemaPath)).digest("hex");
const items=schema.get("items"),paints=schema.get("paint_kits"),prefabs=schema.get("prefabs");
const targets=new Map(),index={},provenance={},missing=[];
const archiveNames=new Map([...vpk.files.keys()].map(path=>[path.toLowerCase(),path]));
// The B2G catalog reuses these finish IDs across knife models. Valve's artwork
// uses a model-specific material variant for the same named finish. These are
// explicit schema/archive mappings, never a fallback to another weapon/finish.
const variants={"507:577":"gs_karam_autotronic","507:562":"cu_karam_lore",
  "507:567":"cu_karam_stonewash","519:410":"aq_damascus_prisma","523:410":"aq_damascus_widow"};
function itemFields(def){
  function inherit(item,depth=0){
    if(!item||depth>10)return new Map();
    const merged=new Map();
    for(const prefab of String(item.get("prefab")??"").split(" ").filter(Boolean))for(const [k,v] of inherit(prefabs.get(prefab),depth+1))merged.set(k,v);
    for(const [k,v] of item)merged.set(k,v);return merged;
  }
  return inherit(items.get(String(def)));
}
function target(def,paint=0,icon=null){
  const item=itemFields(def);const kit=paints.get(String(paint));
  const path=paint>0?`econ/default_generated/${item.get("name")}_${variants[`${def}:${paint}`]??kit?.get("name")}_light_large`:icon??item.get("image_inventory");
  if(path)targets.set(`${def}:${paint}`,`resource/flash/${path}.png`);
}
for(const container of [...B2G_CASES,...B2G_PIN_PACKAGES,...B2G_SOUVENIR_PACKAGES]){
  target(container.definitionIndex,0,container.iconPath);
  for(const reward of [...container.rewards,...(container.specialRewards??[])])target(reward.definitionIndex,reward.paintIndex??0,reward.iconPath);
}
for(const reward of B2G_SPECIAL_REWARDS)target(reward.definitionIndex,reward.paintIndex);
for(const [def,item] of items){
  if(String(item.get("name")).includes("service_medal"))target(Number(def));
}
target(1200);target(1348);target(1349);
const sprays=schema.get("sticker_kits");
for(const spray of B2G_GRAFFITI){
  const kit=sprays.get(String(spray.sprayKitId));
  const material=kit?.get("sticker_material");
  if(material)targets.set(`spray:${spray.sprayKitId}`,`resource/flash/econ/stickers/${material}.png`);
}
let bytes=0;
function withOrigin(png,origin){
  const data=Buffer.from(`impeccable:prompt\0${JSON.stringify(origin)}`,"utf8");
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write("tEXt",4,"ascii");
  data.copy(chunk,8);chunk.writeUInt32BE(crc32(chunk.subarray(4,8+data.length)),8+data.length);
  // Sharp's final chunk is IEND; source information travels inside the file.
  if(png.toString("ascii",png.length-8,png.length-4)!=="IEND")throw new Error("Missing PNG terminator");
  return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
}
try{
  for(const [key,requested] of targets){
    const path=archiveNames.get(requested.toLowerCase())??requested;
    const source=await vpk.read(path);
    if(!source){missing.push({key,path});continue;}
    const origin={origin:"Valve legacy CS:GO inventory artwork",archive:"csgo/pak01_dir.vpk",path,
      sourceSha256:createHash("sha256").update(source).digest("hex"),schemaSha256:schemaHash,
      transform:"256x160 contain; RGBA8 sRGB PNG; original transparency"};
    const png=withOrigin(await sharp(source).resize(256,160,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}})
      .toColourspace("srgb").ensureAlpha().png({compressionLevel:9}).toBuffer(),origin);
    const hash=createHash("sha256").update(png).digest("hex");
    const name=`${hash}.png`;
    if(!provenance[name]){await writeFile(join(out,name),png);bytes+=png.length;
      provenance[name]=origin;}
    index[key]=`/trading-items/${name}`;
  }
}finally{await vpk.close();}
await writeFile(join(root,"packages/db/src/trading-item-images.json"),JSON.stringify(index,null,2)+"\n");
await writeFile(join(out,"PROVENANCE.json"),JSON.stringify({schemaSha256:schemaHash,files:provenance},null,2)+"\n");
await writeFile(join(root,".artifacts/trading-art-missing.json"),JSON.stringify(missing,null,2)+"\n");
// Remove only obsolete generated images listed by our own preceding manifest.
// Each target is one verified basename inside this explicit workspace directory.
for(const name of Object.keys(previous.files??{}))if(/^[a-f0-9]{64}\.png$/.test(name)&&!provenance[name])
  await unlink(join(out,name)).catch(error=>{if(error.code!=="ENOENT")throw error;});
console.log(JSON.stringify({targets:targets.size,mapped:Object.keys(index).length,uniqueImages:Object.keys(provenance).length,bytes,missing:missing.length,examples:missing.slice(0,6)}));
if(missing.length)process.exitCode=1;

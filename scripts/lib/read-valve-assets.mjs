// Build-time readers for Valve's installed KeyValues schema and VPK archive.
import { open, readFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

export async function readKeyValues(path) {
  const input = await readFile(path,"utf8");
  const tokens=[];let index=0;
  while(index<input.length){
    if(/\s/.test(input[index])){index++;continue;}
    if(input.slice(index,index+2)==="//"){const end=input.indexOf("\n",index);index=end<0?input.length:end+1;continue;}
    if(input[index]==="{"||input[index]==="}"){tokens.push(input[index++]);continue;}
    if(input[index++]!=='"')throw new Error(`Unexpected schema token at ${index-1}`);
    let value="";
    while(index<input.length&&input[index]!=='"'){
      if(input[index]==="\\")index++;
      value+=input[index++];
    }
    if(input[index++]!=='"')throw new Error("Unclosed schema string");
    tokens.push(value);
  }
  let cursor=0;
  function merge(target,source){for(const [key,value] of source){const old=target.get(key);if(old instanceof Map&&value instanceof Map)merge(old,value);else target.set(key,value);}}
  function object(depth=0){
    if(depth>32)throw new Error("Schema nesting exceeded");
    const result=new Map();
    while(cursor<tokens.length&&tokens[cursor]!=="}"){
      const key=tokens[cursor++];const token=tokens[cursor++];
      if(token===undefined)throw new Error("Missing schema value");
      const value=token==="{"?object(depth+1):token;
      if(token==="{"&&tokens[cursor++]!=="}")throw new Error("Unclosed schema object");
      const old=result.get(key);if(old instanceof Map&&value instanceof Map)merge(old,value);else result.set(key,value);
    }
    return result;
  }
  const root=object();if(cursor!==tokens.length)throw new Error("Trailing schema data");return root;
}

export async function readVpk(path) {
  const data=await readFile(path);
  if(data.readUInt32LE(0)!==0x55aa1234)throw new Error("Invalid VPK signature");
  const version=data.readUInt32LE(4);if(![1,2].includes(version))throw new Error("Unsupported VPK version");
  const header=version===2?28:12;const end=header+data.readUInt32LE(8);
  if(end>data.length)throw new Error("Incomplete VPK tree");
  const files=new Map();let cursor=header;
  function string(){const zero=data.indexOf(0,cursor);if(zero<cursor||zero>=end)throw new Error("Unclosed VPK string");const value=data.toString("utf8",cursor,zero);cursor=zero+1;return value;}
  for(let extension;(extension=string());){
    for(let directory;(directory=string());){
      for(let name;(name=string());){
        if(cursor+18>end)throw new Error("Incomplete VPK entry");
        const preload=data.readUInt16LE(cursor+4),archive=data.readUInt16LE(cursor+6),offset=data.readUInt32LE(cursor+8),length=data.readUInt32LE(cursor+12);
        if(data.readUInt16LE(cursor+16)!==65535)throw new Error("Invalid VPK entry terminator");
        cursor+=18;if(cursor+preload>end)throw new Error("Incomplete VPK preload");
        files.set(`${directory===" "?"":directory+"/"}${name}.${extension}`,{archive,offset,length,preload:data.subarray(cursor,cursor+preload)});cursor+=preload;
      }
    }
  }
  const archives=new Map();
  return {files,async read(name){
    const entry=files.get(name);if(!entry)return null;
    if(entry.length+entry.preload.length>16*1024*1024)throw new Error("VPK image exceeds build limit");
    if(entry.archive===0x7fff)return Buffer.concat([entry.preload,data.subarray(end+entry.offset,end+entry.offset+entry.length)]);
    const chunk=join(dirname(path),basename(path).replace(/_dir\.vpk$/,`_${String(entry.archive).padStart(3,"0")}.vpk`));
    let handle=archives.get(chunk);if(!handle){handle=await open(chunk,"r");archives.set(chunk,handle);}
    const bytes=Buffer.alloc(entry.length);const result=await handle.read(bytes,0,bytes.length,entry.offset);
    if(result.bytesRead!==entry.length)throw new Error(`Incomplete VPK image: ${name}`);
    return Buffer.concat([entry.preload,bytes]);
  },async close(){await Promise.all([...archives.values()].map(handle=>handle.close()));}};
}

#pragma once

#include <string_view>

// Shared by the case popup and its async-action frame. Each script keeps its
// own lexical reference; opening a reward preview cannot retarget old cleanup.
// Use only APIs present in the pinned 2023 scripts. Do not hook the global $.
constexpr std::string_view B2GPopupLifetime = R"js(
var m_b2g=(function(){
 var p=$.GetContextPanel();
 while(!p.BHasClass('PopupPanel')&&p.GetParent())p=p.GetParent();
 if(p.b2gPopupLifetime)return p.b2gPopupLifetime;
 var closed=false,timers=[],events=[];
 var work={
  Schedule:function(delay,callback){
   if(closed)return null;
   var handle=$.Schedule(delay,function(){
    var i=timers.indexOf(handle);if(i!==-1)timers.splice(i,1);
    if(!closed&&p.IsValid())callback();
   });
   timers.push(handle);return handle;
  },
  CancelScheduled:function(handle){
   var i=timers.indexOf(handle);if(i===-1)return;
   timers.splice(i,1);$.CancelScheduled(handle);
  },
  RegisterForUnhandledEvent:function(name,callback){
   if(closed)return null;
   var handle=$.RegisterForUnhandledEvent(name,function(){
    if(!closed&&p.IsValid())return callback.apply(undefined,arguments);
   });
   events.push([name,handle]);return handle;
  },
  Dispose:function(){
   if(closed)return;closed=true;
   timers.forEach(function(handle){$.CancelScheduled(handle);});timers=[];
   events.forEach(function(event){$.UnregisterForUnhandledEvent(event[0],event[1]);});events=[];
  }
 };
 p.b2gPopupLifetime=work;return work;
})();
)js";

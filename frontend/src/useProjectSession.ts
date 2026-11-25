import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectStateSchema, RuntimeAckSchema, RuntimeCommandSchema, type ProjectState, type RuntimeCommand } from '../../shared/runtime.ts';
import { AudioMessageSchema, type AudioMessage } from '../../shared/speaker.ts';

type Payload = RuntimeCommand extends infer Command ? Command extends RuntimeCommand ? Omit<Command,'v'|'id'|'epoch'|'sessionId'> : never : never;
export function useProjectSession() {
  const [state,setState]=useState<ProjectState|null>(null);
  const audioListeners=useRef(new Set<(message:AudioMessage)=>void>());
  const [connection,setConnection]=useState<'connecting'|'synchronizing'|'online'|'offline'>('connecting');
  const [error,setError]=useState<string|null>(null);
  const socket=useRef<WebSocket|null>(null), current=useRef<ProjectState|null>(null);
  const retryNow=useRef(()=>{});
  const pending=useRef(new Map<string,{epoch:number;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>());
  useEffect(()=>{
    let disposed=false, attempt=0, retry:ReturnType<typeof setTimeout>|undefined;
    let handshake:ReturnType<typeof setTimeout>|undefined;
    const reject=(reason:string, beforeEpoch=Infinity)=>{
      for(const [id,value] of pending.current){if(value.epoch>=beforeEpoch)continue;clearTimeout(value.timer);pending.current.delete(id);value.reject(new Error(reason));}
    };
    const connect=()=>{
      if(disposed||socket.current)return;
      clearTimeout(retry);
      current.current=null;
      setConnection('connecting');
      const next=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);socket.current=next;
      const active=()=>!disposed&&socket.current===next;
      handshake=setTimeout(()=>{if(active()&&!current.current)next.close();},8000);
      next.onopen=()=>{if(active())setConnection('synchronizing');};
      next.onmessage=event=>{
        if(!active())return;
        try{
          const message=JSON.parse(String(event.data));
          if(message.v!==1)throw new Error('Unsupported server protocol');
          if(message.type==='state'){
            const value=ProjectStateSchema.parse(message.state);
            const previous=current.current;
            if(previous&&value.sessionId!==previous.sessionId){next.close();return;}
            if(previous&&value.epoch<previous.epoch)return;
            if(!previous){clearTimeout(handshake);attempt=0;setConnection('online');setError(null);}
            else if(value.epoch>previous.epoch)reject('Guest reset before acknowledgement',value.epoch);
            current.current=value;setState(value);
          }else if(message.type==='audio'){
            const audio=AudioMessageSchema.parse(message);
            if(current.current&&audio.epoch===current.current.epoch)for(const listener of audioListeners.current)listener(audio);
          }else if(message.type==='ack'){
            const ack=RuntimeAckSchema.parse(message);
            const waiting=pending.current.get(ack.id);
            if(!waiting||ack.sessionId!==current.current?.sessionId||ack.epoch<waiting.epoch)return;
            clearTimeout(waiting.timer);pending.current.delete(ack.id);
            if(ack.ok)waiting.resolve();else waiting.reject(new Error(ack.error??'Command rejected'));
          }
        }catch(failure){setError(failure instanceof Error?failure.message:'Invalid server message');}
      };
      next.onclose=()=>{if(!active())return;clearTimeout(handshake);socket.current=null;current.current=null;setConnection('offline');reject('Connection lost');if(attempt++<8)retry=setTimeout(connect,Math.min(8000,500*2**attempt));};
      next.onerror=()=>{if(active())setError('WebSocket connection failed');};
    };
    retryNow.current=()=>{if(!socket.current){attempt=0;connect();}};
    connect();
    return()=>{disposed=true;clearTimeout(retry);clearTimeout(handshake);reject('Connection lost');socket.current?.close();socket.current=null;current.current=null;};
  },[]);
  const renderedSocket=socket.current;
  async function send(payload:Payload, epoch?:number):Promise<void>{
    try { await transmit(payload,epoch); }
    catch (failure) {
      if(payload.action==='gpio-momentary'&&!payload.pressed&&socket.current===renderedSocket&&renderedSocket?.readyState===WebSocket.OPEN){
        current.current=null;setConnection('synchronizing');renderedSocket.close();
      }
      throw failure;
    }
  }
  function transmit(payload:Payload, epoch?:number):Promise<void>{
    const next=socket.current, active=current.current;
    if(next?.readyState!==WebSocket.OPEN||!active||next!==renderedSocket||state?.sessionId!==active.sessionId)throw new Error('No live project connection');
    if((epoch??state.epoch)!==active.epoch)throw new Error('Stale reset epoch');
    if(pending.current.size>=8||next.bufferedAmount>64*1024)throw new Error('Command queue is busy');
    const command=RuntimeCommandSchema.parse({...payload,v:1,id:crypto.randomUUID(),epoch:active.epoch,sessionId:active.sessionId});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.current.delete(command.id);
        if(socket.current===next){current.current=null;setConnection('synchronizing');next.close();}
        reject(new Error('Acknowledgement timed out; reconnecting to check the result'));
      },8000);
      pending.current.set(command.id,{epoch:command.epoch,resolve,reject,timer});
      try{next.send(JSON.stringify(command));}catch(error){clearTimeout(timer);pending.current.delete(command.id);reject(error);}
    });
  }
  const subscribeAudio=useCallback((listener:(message:AudioMessage)=>void)=>{audioListeners.current.add(listener);return()=>{audioListeners.current.delete(listener);};},[]);
  return{state,connection,error,send,subscribeAudio,reconnect:()=>retryNow.current(),reportError:setError};
}

import { useLayoutEffect, useRef, useState } from 'react';
import { Form } from 'react-bootstrap';
import { Download, Eraser, Search, Terminal } from 'lucide-react';

export function useConsoleTail<Element extends HTMLElement>(follow:boolean,content:unknown,layout?:unknown) {
  const scroll=useRef<Element>(null);
  useLayoutEffect(()=>{
    const viewport=scroll.current;
    if(follow&&viewport)viewport.scrollTop=viewport.scrollHeight;
  },[follow,content,layout]);
  useLayoutEffect(()=>{
    const viewport=scroll.current;
    if(!follow||!viewport)return;
    const resize=new ResizeObserver(()=>{viewport.scrollTop=viewport.scrollHeight;});
    resize.observe(viewport);
    return ()=>resize.disconnect();
  },[follow]);
  return scroll;
}

export function SerialMonitor({lines,disabled,onClear}:{lines:string[];disabled:boolean;onClear:()=>Promise<void>}) {
  const [filter,setFilter]=useState(''),[follow,setFollow]=useState(true),[wrap,setWrap]=useState(false);
  const visible=lines.filter(line=>line.toLowerCase().includes(filter.toLowerCase()));
  const text=visible.join('\n');
  const scroll=useConsoleTail<HTMLPreElement>(follow,text,wrap);
  function download(){const url=URL.createObjectURL(new Blob([visible.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='espemu-serial.txt';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section className="serial-monitor"><div className="section-heading"><h2><Terminal size={17}/>Serial Monitor</h2></div><div className="serial-toolbar"><div className="serial-filter"><Search size={15}/><Form.Control type="search" aria-label="Filter serial" placeholder="Filter" size="sm" value={filter} onChange={event=>setFilter(event.target.value)}/></div><Form.Check type="switch" id="serial-follow" label="Follow" checked={follow} onChange={event=>setFollow(event.target.checked)}/><Form.Check type="switch" id="serial-wrap" label="Wrap" checked={wrap} onChange={event=>setWrap(event.target.checked)}/><div className="serial-actions"><button title="Download serial output" aria-label="Download serial output" onClick={download}><Download size={17}/></button><button title="Clear serial output" aria-label="Clear serial output" disabled={disabled} onClick={()=>void onClear()}><Eraser size={17}/></button></div></div><pre ref={scroll} className={`serial-viewport ${wrap?'serial-wrap':''}`} role="log" aria-label="UART output" aria-live="off" tabIndex={0}>{text}</pre></section>;
}

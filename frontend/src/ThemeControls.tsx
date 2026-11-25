import { useEffect, useState } from 'react';
import { Form, Modal } from 'react-bootstrap';
import { Monitor, Moon, Palette, Sun } from 'lucide-react';
import { z } from 'zod';

const ThemeSchema = z.object({ mode: z.enum(['system','light','dark']).default('system'), accent: z.string().regex(/^#[0-9a-f]{6}$/i).default('#087f70'), canvas: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().default(null), serialSize: z.number().int().min(11).max(20).default(13) });
type Theme = z.infer<typeof ThemeSchema>;
function loadTheme(): Theme { try { return ThemeSchema.parse(JSON.parse(localStorage.getItem('espemu.theme.v1') ?? '{}')); } catch { return ThemeSchema.parse({}); } }

export function useTheme() {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme.mode === 'dark' || theme.mode === 'system' && media.matches;
      const root = document.documentElement; root.dataset.bsTheme = dark ? 'dark' : 'light';
      const rgb = [1,3,5].map(index=>parseInt(theme.accent.slice(index,index+2),16));
      const luminance = rgb.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((total,value,index)=>total+value*[.2126,.7152,.0722][index],0);
      const values = {'--paper':dark?'#212724':'#ffffff','--ink':dark?'#e5ece7':'#272f2c','--muted':dark?'#a6b5ac':'#69756f','--line':dark?'#3a4740':'#dce3df','--teal':theme.accent,'--accent-ink':luminance>.179?'#111111':'#ffffff','--page':dark?'#171d19':'#f5f7f6','--canvas':theme.canvas??(dark?'#252f28':'#f3f6f4'),'--serial-font-size':`${theme.serialSize}px`,'--bs-primary':theme.accent,'--bs-primary-rgb':rgb.join(',')};
      for(const [name,value] of Object.entries(values))root.style.setProperty(name,value);
    };
    apply(); media.addEventListener('change',apply);
    try { localStorage.setItem('espemu.theme.v1',JSON.stringify(theme)); } catch {}
    return()=>media.removeEventListener('change',apply);
  },[theme]);
  return {theme,setTheme};
}

export function ThemeControls({theme,onChange}:{theme:Theme;onChange:(value:Theme)=>void}) {
  const [open,setOpen]=useState(false);
  return <><button aria-label="Theme settings" title="Theme settings" onClick={()=>setOpen(true)}><Palette size={18}/></button><Modal show={open} onHide={()=>setOpen(false)} size="sm" centered><Modal.Header closeButton><Modal.Title>Theme</Modal.Title></Modal.Header><Modal.Body>
    <Form.Label>Mode</Form.Label><div className="theme-modes" role="group" aria-label="Theme mode">{([{value:'system',icon:<Monitor size={18}/>},{value:'light',icon:<Sun size={18}/>},{value:'dark',icon:<Moon size={18}/>} ] as const).map(mode=><button key={mode.value} title={mode.value} aria-label={`${mode.value} theme`} aria-pressed={theme.mode===mode.value} onClick={()=>onChange({...theme,mode:mode.value})}>{mode.icon}</button>)}</div>
    <div className="theme-color-row"><Form.Label htmlFor="accent-color">Accent</Form.Label><Form.Control id="accent-color" type="color" value={theme.accent} onChange={event=>onChange({...theme,accent:event.target.value})}/></div>
    <div className="theme-color-row"><Form.Label htmlFor="canvas-color">Canvas</Form.Label><Form.Control id="canvas-color" type="color" value={theme.canvas??(theme.mode==='dark'?'#252f28':'#f3f6f4')} onChange={event=>onChange({...theme,canvas:event.target.value})}/></div>
    <div className="theme-size-row"><Form.Label htmlFor="serial-font-size">Serial font</Form.Label><output>{theme.serialSize} px</output></div><Form.Range id="serial-font-size" min={11} max={20} step={1} value={theme.serialSize} onChange={event=>onChange({...theme,serialSize:Number(event.target.value)})}/>
    <button className="theme-reset" onClick={()=>onChange(ThemeSchema.parse({}))}>Reset theme</button>
  </Modal.Body></Modal></>;
}

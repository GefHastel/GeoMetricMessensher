// Собирает public/icons.js из lucide-static
const fs=require('fs'),path=require('path');
const names=`menu search x arrow-left phone phone-off phone-incoming phone-outgoing phone-missed video video-off mic mic-off paperclip send smile sticker image file file-text ellipsis-vertical check check-check pin pin-off reply forward copy trash-2 pencil user users user-plus megaphone bookmark settings moon sun bell bell-off lock shield database monitor smartphone languages info log-out qr-code camera plus chevron-right chevron-left chevron-down chevron-up archive folder cake-slice at-sign link map-pin bar-chart-3 play pause download square-check circle-check volume-2 volume-x maximize minimize screen-share screen-share-off repeat star ban eye eye-off palette type message-circle clock hash heart zap rotate-ccw refresh-cw message-square-plus calendar sliders-horizontal brush globe mail scan-line circle-x arrow-down arrow-up share-2 external-link smile-plus user-round image-plus sparkles lock-keyhole pen-line contact list-checks badge-check laptop tablet-smartphone circle-dot trash`.split(/\s+/);
const out={};
for(const n of [...new Set(names)]){const f=path.join(__dirname,'../node_modules/lucide-static/icons',n+'.svg');if(!fs.existsSync(f)){console.log('missing',n);continue}
 out[n]=fs.readFileSync(f,'utf8').replace(/<!--.*?-->/s,'').replace(/<svg[^>]*>/,'').replace('</svg>','').replace(/\s+/g,' ').trim();}
fs.writeFileSync(path.join(__dirname,'../public/icons.js'),'window.ICONS='+JSON.stringify(out)+';\n');
console.log(Object.keys(out).length,'icons');

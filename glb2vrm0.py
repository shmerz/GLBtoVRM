"""Convert a humanoid GLB (Mixamo / Avaturn style rig) to a VRM 0.0 with a normalized skeleton (no bone rotations), facing -Z.

Usage: python3 glb2vrm0.py <src.glb> <out.vrm> [normal.png] [--max-mb 10] [--author NAME]   (legacy order <src.glb> <normal.png> <out.vrm> also accepted)
The optional PNG is set as normal map of material 0 (for sources exported without one).
The output is kept under --max-mb (default 10): lossless compaction always, then textures and morph normals are reduced step by step."""
import io,json,os,struct,sys
import numpy as np
args=sys.argv[1:]; max_mb=10.0; author="Unknown"
if '--max-mb' in args: k=args.index('--max-mb'); max_mb=float(args[k+1]); del args[k:k+2]
if '--author' in args: k=args.index('--author'); author=args[k+1]; del args[k:k+2]
if len(args)==3 and args[1].lower().endswith('.png'): args=[args[0],args[2],args[1]]
src,dst=args[:2]; normal_png=args[2] if len(args)>2 else None
f=open(src,'rb').read(); assert f[:4]==b'glTF',"not a binary glTF (.glb) file"
l=struct.unpack('<I',f[12:16])[0]; j=json.loads(f[20:20+l]); b=f[20+l+8:]
assert not {'KHR_draco_mesh_compression','EXT_meshopt_compression'}&set(j.get('extensionsRequired',[])),"compressed meshes (Draco/meshopt) are not supported: export without mesh compression"
n=j['nodes']; par={c:i for i,x in enumerate(n) for c in x.get('children',[])}
def q2m(q):
    x,y,z,w=q
    return np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
def local(x):
    M=np.eye(4); M[:3,:3]=q2m(x.get('rotation',[0,0,0,1]))*np.array(x.get('scale',[1,1,1])); M[:3,3]=x.get('translation',[0,0,0]); return M
def W(i):
    M=np.eye(4)
    while i is not None: M=local(n[i])@M; i=par.get(i)
    return M
CT={5126:'<f4',5123:'<u2',5121:'u1',5125:'<u4'}; NC={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
def read(bv,off,count,nc,dt,stride=None):
    v=j['bufferViews'][bv]; st=stride or v.get('byteStride',nc*dt.itemsize); off+=v.get('byteOffset',0)
    raw=np.frombuffer(b,dtype='u1',count=st*(count-1)+nc*dt.itemsize,offset=off)
    return np.lib.stride_tricks.as_strided(raw,(count,nc*dt.itemsize),(st,1)).copy().view(dt).reshape(count,nc)
def acc(i):
    a=j['accessors'][i]; nc=NC[a['type']]; dt=np.dtype(CT[a['componentType']])
    out=read(a['bufferView'],a.get('byteOffset',0),a['count'],nc,dt) if 'bufferView' in a else np.zeros((a['count'],nc),dt)
    if 'sparse' in a:
        s=a['sparse']; si,sv=s['indices'],s['values']
        ii=read(si['bufferView'],si.get('byteOffset',0),s['count'],1,np.dtype(CT[si['componentType']]),np.dtype(CT[si['componentType']]).itemsize).ravel()
        out[ii]=read(sv['bufferView'],sv.get('byteOffset',0),s['count'],nc,dt,nc*dt.itemsize)
    if a.get('normalized'): out=out/float(np.iinfo(dt).max)
    return out
R=np.diag([-1.0,1.0,-1.0])  # 180 deg around Y: VRM 0.x faces -Z
assert len(j.get('skins',[]))==1,"expected exactly one skin (rigged armature)"
sk=j['skins'][0]; joints=sk['joints']; ibm=acc(sk['inverseBindMatrices']).astype(float).reshape(-1,4,4).transpose(0,2,1)
for k,ji in enumerate(joints): assert np.abs(W(ji)@ibm[k]-np.eye(4)).max()<1e-3,"source is not in bind pose (export it in rest/T-pose)"  # source is in bind pose
bones=[i for i in range(len(n)) if i in set(joints)]
name={i:n[i]['name'].split(':')[-1] for i in bones}  # drop rig prefixes such as "mixamorig1:"
idx={v:k for k,v in name.items()}
miss=[x for x in ['Hips','Spine','Neck','Head']+[S_+x for S_ in ('Left','Right') for x in ('Arm','ForeArm','Hand','UpLeg','Leg','Foot')] if x not in idx]
assert not miss,"not a Mixamo/Avaturn-style rig, missing bones: "+", ".join(miss)
# Re-pose the rest: the source bind pose has splayed legs (~5 deg); make each leg vertical in the
# frontal plane (thigh at the hip, shin at the knee) and counter-rotate the foot so the sole stays flat.
kids={i:n[i].get('children',[]) for i in range(len(n))}
def subtree(i): return [i]+[d for c in kids[i] for d in subtree(c)]
Wp={ji:W(ji) for ji in joints}
def rot_about(i,R3):
    p=Wp[i][:3,3].copy(); M=np.eye(4); M[:3,:3]=R3; T=np.eye(4); T[:3,3]=p; Ti=np.eye(4); Ti[:3,3]=-p
    for d in subtree(i):
        if d in Wp: Wp[d]=T@M@Ti@Wp[d]
def rotz_about(i,theta):
    c,s=np.cos(theta),np.sin(theta); rot_about(i,np.array([[c,-s,0],[s,c,0],[0,0,1]]))
def align(i,c,t):  # rotate bone i (minimal rotation) so that the direction i->c becomes t
    d=Wp[c][:3,3]-Wp[i][:3,3]; d=d/np.linalg.norm(d); t=np.asarray(t,float); v=np.cross(d,t); s,co=np.linalg.norm(v),d@t
    if s<1e-9: return
    K=np.array([[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]])/s; rot_about(i,np.eye(3)+s*K+(1-co)*K@K)
for S_ in ('Left','Right'):
    up,lo,ft=(idx[S_+x] for x in ('UpLeg','Leg','Foot'))
    total=0.0
    for a,c in ((up,lo),(lo,ft)):
        d=Wp[c][:3,3]-Wp[a][:3,3]; th=-np.arctan2(d[0],-d[1]); rotz_about(a,th); total+=th
    rotz_about(ft,-total)
    # Arms: VRM expects a straight T-pose (upper arm, forearm and hand on the X axis). Avaturn rigs bend the
    # forearm ~16 deg forward, which animations then add on top (arms closing on the body): align both segments.
    ua,fa,hd=(idx[S_+x] for x in ('Arm','ForeArm','Hand'))
    sx=np.sign(Wp[hd][0,3]-Wp[ua][0,3])
    for a,c in ((ua,fa),(fa,hd)): align(a,c,[sx,0,0])
pos={ji:R@Wp[ji][:3,3] for ji in joints}
SK=np.stack([Wp[ji]@ibm[k] for k,ji in enumerate(joints)])  # skinning matrices of the new rest pose
# meshes: every primitive skinned into the new rest pose and baked (morph deltas follow the same per-vertex transform)
meshnodes=[i for i,x in enumerate(n) if 'mesh' in x]
assert all(n[i].get('skin')==0 for i in meshnodes) and len({n[i]['mesh'] for i in meshnodes})==len(meshnodes),"every mesh must be skinned to the armature, once"
mesh_ids=sorted({n[i]['mesh'] for i in meshnodes}); mesh_of={mi:k for k,mi in enumerate(mesh_ids)}
NORMAL_EPS=1e-3  # morph normal deltas below this (~0.06 deg) are invisible: dropped from the sparse data
baked=[]
for mi in mesh_ids:
    m=j['meshes'][mi]; prims=[]
    for prim in m['primitives']:
        at=prim['attributes']
        with np.errstate(all="ignore"):  # spurious BLAS warnings on macOS; output is checked for NaN below
            P0=acc(at["POSITION"]).astype(float); N0=acc(at["NORMAL"]).astype(float)
            JI=acc(at['JOINTS_0']).astype(int); WT=acc(at['WEIGHTS_0']).astype(float)
            M=np.einsum('nc,ncij->nij',WT,SK[JI]); L=np.einsum('ij,njk->nik',R,M[:,:3,:3])
            P=np.einsum('nij,nj->ni',L,P0)+M[:,:3,3]@R.T; N=np.einsum('nij,nj->ni',L,N0)
            N/=np.linalg.norm(N,axis=1,keepdims=True)
            T=[{k:np.einsum('nij,nj->ni',L,acc(v).astype(float)).astype('<f4') for k,v in t.items() if k in ('POSITION','NORMAL')} for t in prim.get('targets',[])]
        assert np.isfinite(P).all() and np.isfinite(N).all() and all(np.isfinite(v).all() for t in T for v in t.values())
        for t in T:
            if 'NORMAL' in t: t['NORMAL'][np.abs(t['NORMAL']).max(1)<NORMAL_EPS]=0
        prims.append({"P":P.astype('<f4'),"N":N.astype('<f4'),"UV":acc(at['TEXCOORD_0']).astype('<f4'),"JI":JI,"WT":WT.astype('<f4'),
                      "I":acc(prim['indices']).ravel(),"material":prim.get('material'),"T":T})
    baked.append((m,prims))
newmeshes=[{"name":m.get('name','Body'),**({"extras":m['extras']} if 'extras' in m else {})} for m,_ in baked]
IBM=np.stack([np.eye(4) for _ in joints])
for k,ji in enumerate(joints): IBM[k][:3,3]=-pos[ji]
# textures: embedded images, plus the optional normal map override for material 0
src_images=[]
for im in j.get('images',[]):
    v=j['bufferViews'][im['bufferView']]; o=v.get('byteOffset',0); src_images.append((im,b[o:o+v['byteLength']]))
textures=[dict(t) for t in j.get('textures',[])]
samplers=j.get('samplers') or [{"magFilter":9729,"minFilter":9987,"wrapS":10497,"wrapT":10497}]
materials=j['materials']
if normal_png:
    src_images.append(({"name":"Normal","mimeType":"image/png"},open(normal_png,'rb').read()))
    textures.append({"source":len(src_images)-1,"sampler":0}); materials[0]['normalTexture']={"index":len(textures)-1}
# BLEND hair/cards (alpha texture almost binary) -> MASK: three.js sorts BLEND per object and does not write depth,
# so hair shows see-through artifacts against other transparent objects. Uniform translucency (corneas, lenses) stays BLEND.
MASK_CUTOFF=0.5
def alpha_binary(ti):
    from PIL import Image
    a=np.asarray(Image.open(io.BytesIO(src_images[textures[ti]['source']][1])).convert('RGBA').getchannel('A'),float)/255
    return ((a>0.1)&(a<0.9)).mean()<0.25 and (a<0.1).mean()>0.05
for m in materials:
    t=m.get('pbrMetallicRoughness',{}).get('baseColorTexture')
    if m.get('alphaMode')=='BLEND' and t and alpha_binary(t['index']): m['alphaMode']='MASK'; m['alphaCutoff']=MASK_CUTOFF; print(f"material {m.get('name')}: BLEND -> MASK")
def shrink(im,data,tex_max):  # re-encode (JPEG q85, PNG optimized) at most tex_max px; keep the original if not smaller
    from PIL import Image
    img=Image.open(io.BytesIO(data)); img.thumbnail((tex_max,tex_max),Image.LANCZOS); buf=io.BytesIO()
    if im['mimeType']=='image/png': img.save(buf,'PNG',optimize=True)
    else: img.convert('RGB').save(buf,'JPEG',quality=85,optimize=True)
    return buf.getvalue() if len(buf.getvalue())<len(data) or max(Image.open(io.BytesIO(data)).size)>tex_max else data
# nodes: Root -> skeleton (translation only), mesh nodes at scene root
newn=[{"name":"Root","children":[]}]; nmap={}
for i in bones: nmap[i]=len(newn); newn.append({"name":n[i]['name']})
for i in bones:
    p=par.get(i); t=pos[i]-(pos[p] if p in nmap else 0)
    newn[nmap[i]]['translation']=[float(x) for x in t]
    ch=[nmap[c] for c in n[i].get('children',[]) if c in nmap]
    if ch: newn[nmap[i]]['children']=ch
    if p not in nmap: newn[0]['children'].append(nmap[i])
meshnode0=len(newn)
for i in meshnodes: newn.append({"name":n[i].get('name',newmeshes[mesh_of[n[i]['mesh']]]['name']),"mesh":mesh_of[n[i]['mesh']],"skin":0})
MAP={"hips":"Hips","spine":"Spine","chest":"Spine1","upperChest":"Spine2","neck":"Neck","head":"Head","leftEye":"LeftEye","rightEye":"RightEye"}
for side,S_ in (("left","Left"),("right","Right")):
    for k,v in (("Shoulder","Shoulder"),("UpperArm","Arm"),("LowerArm","ForeArm"),("Hand","Hand"),("UpperLeg","UpLeg"),("LowerLeg","Leg"),("Foot","Foot"),("Toes","ToeBase")):
        MAP[side+k]=S_+v
    for fi,F in (("Thumb","Thumb"),("Index","Index"),("Middle","Middle"),("Ring","Ring"),("Little","Pinky")):
        for k,s in enumerate(("Proximal","Intermediate","Distal"),1): MAP[side+fi+s]=f"{S_}Hand{F}{k}"
MAP={k:v for k,v in MAP.items() if v in idx}
head=idx['Head']
if 'LeftEye' in idx and 'RightEye' in idx: eo=(pos[idx['LeftEye']]+pos[idx['RightEye']])/2-pos[head]; eo[2]=0.0
else: eo=np.array([0.0,0.06,0.0])
# expressions: VRM 0.0 presets driven by ARKit blendshapes when the meshes have them (weights 0-100)
ARKIT={"a":{"jawOpen":60,"mouthLowerDownLeft":30,"mouthLowerDownRight":30},
 "i":{"jawOpen":15,"mouthStretchLeft":60,"mouthStretchRight":60,"mouthSmileLeft":20,"mouthSmileRight":20},
 "u":{"jawOpen":10,"mouthPucker":80},
 "e":{"jawOpen":30,"mouthStretchLeft":40,"mouthStretchRight":40},
 "o":{"jawOpen":35,"mouthFunnel":80},
 "blink":{"eyeBlinkLeft":100,"eyeBlinkRight":100},"blink_l":{"eyeBlinkLeft":100},"blink_r":{"eyeBlinkRight":100},
 "angry":{"browDownLeft":100,"browDownRight":100,"noseSneerLeft":50,"noseSneerRight":50,"mouthFrownLeft":40,"mouthFrownRight":40},
 "fun":{"mouthSmileLeft":60,"mouthSmileRight":60,"cheekSquintLeft":30,"cheekSquintRight":30},
 "joy":{"mouthSmileLeft":100,"mouthSmileRight":100,"cheekSquintLeft":60,"cheekSquintRight":60,"eyeSquintLeft":30,"eyeSquintRight":30},
 "sorrow":{"browInnerUp":100,"mouthFrownLeft":70,"mouthFrownRight":70}}
def binds(preset):
    return [{"mesh":k,"index":m['extras']['targetNames'].index(t),"weight":float(w)} for t,w in ARKIT.get(preset,{}).items()
            for k,m in enumerate(newmeshes) if t in m.get('extras',{}).get('targetNames',[])]
curve=[0.0,0.0,0.0,1.0,1.0,1.0,1.0,0.0]
vrm={"exporterVersion":"VRMconverter-glb2vrm0-3","specVersion":"0.0",
 "meta":{"title":os.path.splitext(os.path.basename(dst))[0].split('.')[0],"version":"1","author":author,"contactInformation":"","reference":"",
   "allowedUserName":"OnlyAuthor","violentUssageName":"Disallow","sexualUssageName":"Disallow","commercialUssageName":"Disallow",
   "otherPermissionUrl":"","licenseName":"Redistribution_Prohibited","otherLicenseUrl":""},
 "humanoid":{"humanBones":[{"bone":k,"node":nmap[idx[v]],"useDefaultValues":True} for k,v in MAP.items()],
   "armStretch":0.05,"legStretch":0.05,"upperArmTwist":0.5,"lowerArmTwist":0.5,"upperLegTwist":0.5,"lowerLegTwist":0.5,"feetSpacing":0,"hasTranslationDoF":False},
 "firstPerson":{"firstPersonBone":nmap[head],"firstPersonBoneOffset":{"x":float(eo[0]),"y":float(eo[1]),"z":float(eo[2])},
   "meshAnnotations":[{"mesh":k,"firstPersonFlag":"Auto"} for k in range(len(newmeshes))],
   "lookAtTypeName":"Bone",
   "lookAtHorizontalInner":{"curve":curve,"xRange":90.0,"yRange":8.0},"lookAtHorizontalOuter":{"curve":curve,"xRange":90.0,"yRange":12.0},
   "lookAtVerticalDown":{"curve":curve,"xRange":90.0,"yRange":10.0},"lookAtVerticalUp":{"curve":curve,"xRange":90.0,"yRange":10.0}},
 "blendShapeMaster":{"blendShapeGroups":[{"name":p,"presetName":p,"binds":binds(p),"materialValues":[],"isBinary":False} for p in
   ("neutral","a","i","u","e","o","blink","blink_l","blink_r","angry","fun","joy","sorrow")]},
 "secondaryAnimation":{"boneGroups":[],"colliderGroups":[]},
 "materialProperties":[{"name":m.get("name","Body"),"shader":"VRM_USE_GLTFSHADER","renderQueue":{"BLEND":3000,"MASK":2450}.get(m.get('alphaMode'),2000),
   "keywordMap":{},"tagMap":{},"floatProperties":{},"vectorProperties":{},"textureProperties":{}} for m in materials]}
def build(tex_max,morph_normals):
    out=bytearray(); views=[]; accs=[]
    def add(data,target=None):
        while len(out)%4: out.extend(b'\0')
        v={"buffer":0,"byteOffset":len(out),"byteLength":len(data)}
        if target: v["target"]=target
        out.extend(data); views.append(v); return len(views)-1
    def addacc(arr,typ,ct,target=None,minmax=False,**kw):
        a={"bufferView":add(arr.tobytes(),target),"componentType":ct,"count":len(arr),"type":typ,**kw}
        if minmax: a["min"]=[float(x) for x in arr.min(0)]; a["max"]=[float(x) for x in arr.max(0)]
        accs.append(a); return len(accs)-1
    def addsparse(arr):  # morph delta: store only the moved vertices
        nz=np.nonzero(np.abs(arr).max(1)>0)[0].astype('<u4')
        a={"componentType":5126,"count":len(arr),"type":"VEC3","min":[float(x) for x in arr.min(0)],"max":[float(x) for x in arr.max(0)]}
        if len(nz): a["sparse"]={"count":len(nz),"indices":{"bufferView":add(nz.tobytes()),"componentType":5125},"values":{"bufferView":add(arr[nz].tobytes())}}
        accs.append(a); return len(accs)-1
    meshes=[]
    for nm,(m,prims) in zip(newmeshes,baked):
        ps=[]
        for q in prims:
            small=len(joints)<256; short=len(q["P"])<65535  # 8-bit joints / 16-bit indices when they fit
            p={"attributes":{"POSITION":addacc(q["P"],'VEC3',5126,34962,True),"NORMAL":addacc(q["N"],'VEC3',5126,34962),
                "TEXCOORD_0":addacc(q["UV"],'VEC2',5126,34962),
                "JOINTS_0":addacc(q["JI"].astype('u1' if small else '<u2'),'VEC4',5121 if small else 5123,34962),
                "WEIGHTS_0":addacc(q["WT"],'VEC4',5126,34962)},
               "indices":addacc(q["I"].astype('<u2' if short else '<u4'),'SCALAR',5123 if short else 5125,34963),"mode":4}
            if q["material"] is not None: p['material']=q["material"]
            if q["T"]: p['targets']=[{k:addsparse(v) for k,v in t.items() if morph_normals or k=='POSITION'} for t in q["T"]]
            ps.append(p)
        meshes.append({**nm,"primitives":ps,**({"weights":m['weights']} if 'weights' in m else {})})
    images=[{**im,"bufferView":add(data if tex_max is None else shrink(im,data,tex_max))} for im,data in src_images]
    out_j={"asset":{"version":"2.0","generator":"VRMconverter glb2vrm0.py"},"scene":0,
     "scenes":[{"nodes":[0]+list(range(meshnode0,len(newn)))}],"nodes":newn,"meshes":meshes,
     "skins":[{"joints":[nmap[ji] for ji in joints],"inverseBindMatrices":addacc(IBM.transpose(0,2,1).reshape(-1,16).astype('<f4'),'MAT4',5126),"skeleton":0}],
     "materials":materials,"textures":textures,"samplers":samplers,"images":images,
     "accessors":accs,"bufferViews":views,"buffers":[{"byteLength":0}],
     "extensionsUsed":sorted(set(j.get('extensionsUsed',[]))|{"VRM"}),"extensions":{"VRM":vrm}}
    if not images: del out_j['images'],out_j['textures']
    while len(out)%4: out.extend(b'\0')
    out_j['buffers'][0]['byteLength']=len(out)
    js=json.dumps(out_j,separators=(',',':')).encode(); js+=b' '*((4-len(js)%4)%4)
    return struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(out))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(out),0x004E4942)+bytes(out)
# size budget: first step that fits wins, from untouched textures to 256 px textures without morph normals
STEPS=[(None,True,"original textures"),(2048,True,"textures re-encoded, max 2048 px"),(1024,True,"textures re-encoded, max 1024 px"),(512,True,"textures max 512 px"),
       (512,False,"textures max 512 px, no morph normals"),(256,False,"textures max 256 px, no morph normals")]
for tex_max,mn,label in STEPS:
    data=build(tex_max,mn)
    if len(data)<=max_mb*1e6: break
open(dst,'wb').write(data)
print(f"{dst}: {len(data)/1e6:.2f} MB ({label})"+("" if len(data)<=max_mb*1e6 else f" -- WARNING: over the {max_mb:g} MB budget"))

# One-off generator for fixtures/slurm/demo_inventory.txt (synthetic data; GPU counts invented).
T = "nvidia_geforce_rtx_2080_ti"; A = "nvidia_rtx_a6000"
def node(name, parts, state, gres, cfg_gpu, alloc_gpu, cpu=16, cpualloc=0, reason=None):
    r = f" Reason={reason}" if reason else ""
    return (f"NodeName={name} Arch=x86_64 CoresPerSocket=8 CPUAlloc={cpualloc} CPUEfctv={cpu} CPUTot={cpu} CPULoad=0.10 "
            f"AvailableFeatures=(null) ActiveFeatures=(null) Gres={gres} NodeAddr={name} NodeHostName={name} Version=23.11.4 "
            f"OS=Linux 5.14.0-427.el9.x86_64 #1 SMP PREEMPT_DYNAMIC RealMemory=64000 AllocMem={cpualloc*2000} FreeMem=50000 "
            f"Sockets=2 Boards=1 State={state} ThreadsPerCore=1 TmpDisk=0 Weight=1 Owner=N/A MCS_label=N/A Partitions={parts} "
            f"BootTime=2026-09-01T10:00:00 SlurmdStartTime=2026-09-01T10:01:00 "
            f"CfgTRES=cpu={cpu},mem=64000M,billing={cpu}{cfg_gpu} AllocTRES={alloc_gpu}{r} CapWatts=n/a CurrentWatts=0")
def g(t, n): return f"gpu:{t}:{n}(S:0-1)"
nodes = [
 node("landonia01","Interactive","IDLE",g(T,4),",gres/gpu=4",""),
 node("landonia02","Interactive","MIXED",g(T,4),",gres/gpu=4","cpu=4,mem=8000M,gres/gpu=1",cpualloc=4),
 node("landonia03","Teaching,ICF-Free","MIXED",g(T,4),",gres/gpu=4","cpu=8,mem=16000M,gres/gpu=2",cpualloc=8),
 node("landonia05","Teaching,ICF-Free","IDLE",g(T,4),",gres/gpu=4",""),
 node("landonia08","Teaching,ICF-Free","MIXED+DRAIN",g(T,4),",gres/gpu=4","cpu=2,mem=4000M,gres/gpu=1",cpualloc=2,reason="scheduled maintenance [admin@2026-10-15T09:00:00]"),
 node("landonia11","Teaching,ICF-Free","MIXED",g(A,8),",gres/gpu=8","cpu=20,mem=80000M,gres/gpu=5",cpu=32,cpualloc=20),
 node("landonia21","ICF-Free","MIXED","gpu:2","","cpu=4,mem=8000M",cpualloc=4),
 node("landonia23","Teaching,ICF-Free","DOWN*+NOT_RESPONDING",g(T,4),",gres/gpu=4","",reason="Not responding [slurm@2026-10-16T08:12:00]"),
 node("landonia25","Teaching,ICF-Free","ALLOCATED",g(T,4),",gres/gpu=4","cpu=16,mem=32000M,gres/gpu=4",cpualloc=16),
 node("crannog01","Teaching,ICF-Free","MIXED",g(A,4),",gres/gpu=4","cpu=8,mem=16000M,gres/gpu=3",cpu=32,cpualloc=8),
 node("crannog02","Teaching,ICF-Free","IDLE",g(A,4),",gres/gpu=4","",cpu=32),
 node("damnii07","Teaching,ICF-Free","IDLE",g(T,2),",gres/gpu=2",""),
 node("damnii08","Teaching,ICF-Free","MIXED",g(T,2),",gres/gpu=2","cpu=2,mem=4000M,gres/gpu=2",cpualloc=2),
 node("damnii09","Teaching,ICF-Free","IDLE","(null)","",""),
 node("saxa","Teaching,ICF-Free","MIXED","gpu:nvidia_h200:2(S:0),gpu:nvidia_h200_3g.71gb:4(S:1)",
      ",gres/gpu=6,gres/gpu:nvidia_h200=2,gres/gpu:nvidia_h200_3g.71gb=4","cpu=24,mem=200000M,gres/gpu=3,gres/gpu:nvidia_h200=1,gres/gpu:nvidia_h200_3g.71gb=2",cpu=64,cpualloc=24),
 node("herman","ICF-Free,ICF-Research","MIXED",f"gpu:{A}:2(S:0),gpu:{T}:2(S:1)",",gres/gpu=4","cpu=8,mem=16000M,gres/gpu=1",cpu=32,cpualloc=8),
 node("scotia01","ICF-Free,ICF-Research","MIXED","gpu:nvidia_a40:4(S:0-1)",",gres/gpu=4","cpu=16,mem=32000M,gres/gpu=2",cpu=32,cpualloc=16),
 node("scotia02","ICF-Free,ICF-Research","IDLE","gpu:nvidia_a40:4(S:0-1)",",gres/gpu=4","",cpu=32),
 node("openr01","Open-Research","IDLE","gpu:nvidia_a100:4(S:0-1)",",gres/gpu=4","",cpu=64),
]
def part(name, nodes, maxtime, default="NO", groups="ALL"):
    return (f"PartitionName={name} AllowGroups={groups} AllowAccounts=ALL AllowQos=ALL AllocNodes=ALL Default={default} QoS=N/A "
            f"DefaultTime=NONE DisableRootJobs=NO ExclusiveUser=NO GraceTime=0 Hidden=NO MaxNodes=UNLIMITED MaxTime={maxtime} MinNodes=0 "
            f"LLN=NO MaxCPUsPerNode=UNLIMITED Nodes={nodes} PriorityJobFactor=1 PriorityTier=1 RootOnly=NO ReqResv=NO OverSubscribe=NO "
            f"OverTimeLimit=NONE PreemptMode=OFF State=UP SelectTypeParameters=NONE JobDefaults=(null) DefMemPerNode=UNLIMITED MaxMemPerNode=UNLIMITED")
parts = [
 part("Interactive","landonia[01-02]","4:00:00"),
 part("Teaching","crannog[01-02],damnii[07-09],landonia[03,05,08,11,23,25],saxa","2-00:00:00",default="YES"),
 part("ICF-Free","crannog[01-02],damnii[07-09],herman,landonia[03,05,08,11,21,23,25],saxa,scotia[01-02]","2-00:00:00"),
 part("ICF-Research","herman,scotia[01-02]","2-00:00:00"),
 part("Open-Research","openr01","7-00:00:00",groups="researchers"),
]
out = ["# SYNTHETIC DEMO DATA - not live ICF output. Topology after the public ICF tutorial; GPU counts invented.",
       "@@partitions", *parts, "@@rc 0", "@@nodes", *nodes, "@@rc 0", ""]
open("fixtures/slurm/demo_inventory.txt","w").write("\n".join(out))

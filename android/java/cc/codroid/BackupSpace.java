package cc.codroid;
/** Conservative ZIP64 bound and a reserve kept free on the destination filesystem. */
final class BackupSpace {
    static final long MiB=1024L*1024,GiB=1024*MiB;
    static long add(long a,long b)throws java.io.IOException{
        if(a<0||b<0||a>Long.MAX_VALUE-b)throw new java.io.IOException("备份大小超出支持范围");return a+b;
    }
    static long estimate(FullBackup.Manifest m)throws java.io.IOException{
        // Deflate overhead is much less than 1%; keep 1% plus framing and a fixed margin.
        long bytes=add(m.total,m.total/100);
        bytes=add(bytes,8*MiB);
        for(FullBackup.Entry e:m.entries){
            bytes=add(bytes,512);
            bytes=add(bytes,e.path.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            bytes=add(bytes,e.link.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        }
        return bytes;
    }
    static long reserve(long volumeBytes){
        return Math.max(256*MiB,Math.min(4*GiB,volumeBytes/100));
    }
    static void check(long available,long estimated,long reserve)throws java.io.IOException{
        if(available<0)throw new java.io.IOException("所选位置无法提供剩余空间信息，请选择可查询容量的本机、SD 卡或 USB 存储");
        if(estimated<0||reserve<0||available<reserve||estimated>available-reserve)
            throw new java.io.IOException("备份位置空间不足：预计需要 "+BackupUi.bytes(estimated)+"，当前可用 "+BackupUi.bytes(available)+"，另需预留 "+BackupUi.bytes(reserve)+"。请更换位置或清理空间");
    }
    interface Capacity {long[] read()throws java.io.IOException;}
    static final class Monitor {
        final long estimated;final Capacity capacity;long available=-1,reserve,last=-1,since;
        Monitor(long estimate,Capacity capacity){this.estimated=estimate;this.capacity=capacity;}
        void preflight()throws java.io.IOException{
            long[] stats=capacity.read();
            if(stats==null||stats.length!=2||stats[1]<=0)throw new java.io.IOException("无法可靠读取目标容量");
            available=stats[0];reserve=BackupSpace.reserve(stats[1]);BackupSpace.check(available,estimated,reserve);
        }
        void beforeWrite(int n,long now)throws java.io.IOException{
            if(n<0)throw new java.io.IOException("写入大小无效");
            since+=n;
            if(last<0||since>=8*MiB||now-last>=1000){
                long[] stats=capacity.read();available=stats==null||stats.length!=2?-1:stats[0];
                if(available<reserve+n)throw new java.io.IOException("目标可用空间低于安全预留阈值，已停止导出，避免写满存储");
                last=now;since=0;
            }
        }
    }

}

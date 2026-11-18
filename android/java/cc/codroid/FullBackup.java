package cc.codroid;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Streaming ZIP64 logical backup. No Android dependency; restore is staged and journaled. */
final class FullBackup {
    static final String MAGIC="CCCDROID-FULL-BACKUP";
    static final int FORMAT=2, MAX_ENTRIES=2000000;
    static final String HEADER="backup-header.bin", CHECKSUMS="backup-sha256.bin";
    interface Progress { void update(String phase,long done,long total,String path); }
    interface Cancel { boolean cancelled(); }
    interface Fault { void checkpoint(String step,String path); }
    static final Progress QUIET=(p,d,t,n)->{};
    static final Cancel NEVER=()->false;
    static final class Cancelled extends IOException { Cancelled(){super("已取消，当前数据未被覆盖");} }
    static final class Entry {
        String path,link; byte type; int mode; long size,mtime; byte[] sha;
        Entry(String p,byte t,int m,long s,long mt,String l){path=p;type=t;mode=m;size=s;mtime=mt;link=l;}
    }
    static final class Manifest {
        String pkg,arch,dataPath,appVersionName=""; int appVersion; long created,total;
        final List<Entry> entries=new ArrayList<>();
    }
    private final Path data,work;
    private final String pkg,arch;
    private final int maxVersion;
    private final String currentVersionName;
    FullBackup(Path data,Path work,String pkg,String arch)throws IOException {this(data,work,pkg,arch,Integer.MAX_VALUE);}
    FullBackup(Path data,Path work,String pkg,String arch,int maxVersion)throws IOException {this(data,work,pkg,arch,maxVersion,"");}
    FullBackup(Path data,Path work,String pkg,String arch,int maxVersion,String currentVersionName)throws IOException {
        this.maxVersion=maxVersion;this.currentVersionName=currentVersionName==null?"":currentVersionName;
        this.data=data.toRealPath();this.work=work.toAbsolutePath().normalize();this.pkg=pkg;this.arch=arch;
        if(this.work.startsWith(this.data.resolve("files")))throw new IOException("备份工作目录不能位于被备份的目录内");
    }
    static boolean exists(Path p){return Files.exists(p,LinkOption.NOFOLLOW_LINKS);}
    static boolean allowed(String p){
        if(p==null||p.isEmpty()||p.length()>8192||p.startsWith("/")||p.contains("\\")||p.indexOf('\0')>=0)return false;
        for(String x:p.split("/",-1))if(x.isEmpty()||x.equals(".")||x.equals(".."))return false;
        if(p.equals("databases")||p.startsWith("databases/"))return true;
        if(p.equals("shared_prefs"))return true;
        if(p.startsWith("shared_prefs/"))return !p.equals("shared_prefs/consent.xml")&&!p.equals("shared_prefs/consent.xml.bak")&&!p.equals("shared_prefs/intent.xml")&&!p.equals("shared_prefs/intent.xml.bak");
        if(!p.startsWith("files/"))return false;
        String[] parts=p.split("/");String top=parts[1];
        if(top.equals("app")||top.equals("gw")||top.equals("cache")||top.equals(".backup-ui-pending")||top.startsWith(".adb")||top.equals(".priv.sock")||top.startsWith(".app-"))return false;
        if(p.equals("files/usr/tmp")||p.startsWith("files/usr/tmp/"))return false;
        if(p.startsWith("files/home/")){
            String q=p.substring("files/home/".length());
            if(q.equals(".gateway-token")||q.equals(".run-active")||q.equals(".ccapp-instance.json")||q.equals(".ccapp-children.json")||q.equals(".gateway.pid")||q.equals(".adb-control")||q.startsWith(".adb-control/"))return false;
        }
        return true;
    }
    static void check(Cancel c)throws Cancelled {if(c.cancelled()||Thread.currentThread().isInterrupted())throw new Cancelled();}
    private List<Path> roots()throws IOException {
        List<Path> out=new ArrayList<>();
        Path files=data.resolve("files");
        if(exists(files)){if(Files.isSymbolicLink(files)||!Files.isDirectory(files))throw new IOException("应用 files 目录无效");
            try(DirectoryStream<Path> ds=Files.newDirectoryStream(files)){for(Path p:ds)if(allowed("files/"+p.getFileName()))out.add(p);}}
        for(String n:new String[]{"databases","shared_prefs"})if(exists(data.resolve(n)))out.add(data.resolve(n));
        out.sort(Comparator.comparing(Path::toString));return out;
    }
    Manifest scan(int version,Progress progress,Cancel cancel)throws Exception {return scan(version,"",progress,cancel);}
    Manifest scan(int version,String versionName,Progress progress,Cancel cancel)throws Exception {
        Manifest m=new Manifest();m.pkg=pkg;m.arch=arch;m.dataPath=data.toString();m.created=System.currentTimeMillis();m.appVersion=version;
        m.appVersionName=versionName==null?"":versionName;checkVersionName(m.appVersionName);
        progress.update("scanning",0,0,"");
        for(Path root:roots()){
            Files.walkFileTree(root,EnumSet.noneOf(FileVisitOption.class),Integer.MAX_VALUE,new SimpleFileVisitor<Path>(){
                private FileVisitResult add(Path p,BasicFileAttributes attrs)throws IOException{
                    check(cancel);String rel=data.relativize(p).toString().replace(File.separatorChar,'/');
                    if(!allowed(rel))return attrs.isDirectory()?FileVisitResult.SKIP_SUBTREE:FileVisitResult.CONTINUE;
                    if(!attrs.isDirectory()&&!attrs.isRegularFile()&&!attrs.isSymbolicLink())return FileVisitResult.CONTINUE;
                    if(m.entries.size()>=MAX_ENTRIES)throw new IOException("备份文件数量超过支持上限");
                    byte type=(byte)(attrs.isDirectory()?0:attrs.isRegularFile()?1:2);
                    long size=type==1?attrs.size():0;
                    if(size<0||m.total>Long.MAX_VALUE-size)throw new IOException("备份大小无效");
                    m.total+=size;
                    m.entries.add(new Entry(rel,type,mode(p),size,attrs.lastModifiedTime().toMillis(),type==2?Files.readSymbolicLink(p).toString():""));
                    progress.update("scanning",m.entries.size(),0,rel);
                    return FileVisitResult.CONTINUE;
                }
                @Override public FileVisitResult preVisitDirectory(Path p,BasicFileAttributes a)throws IOException{return add(p,a);}
                @Override public FileVisitResult visitFile(Path p,BasicFileAttributes a)throws IOException{return add(p,a);}
                @Override public FileVisitResult visitFileFailed(Path p,IOException e)throws IOException{throw e;}
            });
        }
        return m;
    }
    private static MessageDigest digest()throws Exception{return MessageDigest.getInstance("SHA-256");}
    static int mode(Path p)throws IOException{
        if(Files.isSymbolicLink(p))return 0777;
        Set<PosixFilePermission> perms=Files.getPosixFilePermissions(p,LinkOption.NOFOLLOW_LINKS);
        int mode=0,i=8;for(PosixFilePermission bit:PosixFilePermission.values()){if(perms.contains(bit))mode|=1<<i;i--;}return mode;
    }
    private static void chmod(Path p,int mode)throws IOException{
        Set<PosixFilePermission> bits=EnumSet.noneOf(PosixFilePermission.class);int i=8;
        for(PosixFilePermission bit:PosixFilePermission.values()){if((mode&(1<<i))!=0)bits.add(bit);i--;}
        Files.setPosixFilePermissions(p,bits);
    }
    private static void string(DataOutputStream o,String s)throws IOException{
        byte[] b=s.getBytes(StandardCharsets.UTF_8);if(b.length>32768)throw new IOException("路径过长");o.writeInt(b.length);o.write(b);
    }
    private static String string(DataInputStream in)throws IOException{
        int n=in.readInt();if(n<0||n>32768)throw new IOException("备份文本字段无效");byte[] b=new byte[n];in.readFully(b);return new String(b,StandardCharsets.UTF_8);
    }
    private static void checkVersionName(String name)throws IOException{
        if(name.length()>256||name.chars().anyMatch(Character::isISOControl))throw new IOException("备份版本名称无效");
    }
    static void header(DataOutputStream out,Manifest m)throws IOException{
        string(out,MAGIC);out.writeInt(FORMAT);string(out,m.pkg);string(out,m.arch);string(out,m.dataPath);
        out.writeInt(m.appVersion);checkVersionName(m.appVersionName);string(out,m.appVersionName);out.writeLong(m.created);out.writeLong(m.total);out.writeInt(m.entries.size());
        for(Entry e:m.entries){string(out,e.path);out.writeByte(e.type);out.writeInt(e.mode);out.writeLong(e.size);out.writeLong(e.mtime);string(out,e.link);}
        out.flush();
    }
    private Manifest readHeader(DataInputStream in)throws IOException{
        if(!string(in).equals(MAGIC))throw new IOException("不是受支持的 CCCDroid 完整备份包");
        int format=in.readInt();if(format!=1&&format!=FORMAT)throw new IOException("备份格式不受支持，请使用兼容版本的 CCCDroid");
        Manifest m=new Manifest();m.pkg=string(in);m.arch=string(in);m.dataPath=string(in);m.appVersion=in.readInt();
        if(format>=2){m.appVersionName=string(in);checkVersionName(m.appVersionName);}
        m.created=in.readLong();m.total=in.readLong();int n=in.readInt();
        if(!m.pkg.equals(pkg)||!m.arch.equals(arch)||!m.dataPath.equals(data.toString()))throw new IOException("备份的包名、架构或应用目录不兼容；工具包中的固定路径不能跨包名恢复");
        if(n<0||n>MAX_ENTRIES||m.total<0)throw new IOException("备份规模无效");
        long total=0;Map<String,Byte> paths=new HashMap<>();
        for(int i=0;i<n;i++){
            String p=string(in);byte type=in.readByte();int mode=in.readInt();long size=in.readLong(),mtime=in.readLong();String link=string(in);
            if(!allowed(p)||type<0||type>2||(mode&~0777)!=0||type==0&&(mode&0500)!=0500||type==1&&(mode&0400)==0||size<0||(type!=1&&size!=0)||paths.put(p,type)!=null||type!=2&&!link.isEmpty()||type==2&&(link.isEmpty()||link.indexOf('\0')>=0))throw new IOException("备份条目无效或重复");
            if(total>Long.MAX_VALUE-size)throw new IOException("备份大小溢出");
            total+=size;m.entries.add(new Entry(p,type,mode,size,mtime,link));
        }
        if(total!=m.total)throw new IOException("备份总大小与清单不一致");
        if(m.appVersion<1)throw new IOException("备份构建号无效");
        if(m.appVersion>maxVersion)throw new IOException("备份来自更新版本，不能导入：\n备份版本："+BackupUi.versionLabel(m.appVersion,m.appVersionName)+"\n当前版本："+BackupUi.versionLabel(maxVersion,currentVersionName)+"\n请先更新应用后再导入；当前数据未被覆盖");
        if(!Byte.valueOf((byte)0).equals(paths.get("files/home")))throw new IOException("备份缺少内部 home 目录");
        for(Entry e:m.entries){
            String p=e.path;
            while(p.contains("/")){p=p.substring(0,p.lastIndexOf('/'));Byte t=paths.get(p);if(t!=null&&t!=0)throw new IOException("备份包含链接或文件祖先路径");}
        }
        return m;
    }
    void exportTo(OutputStream output,Manifest m,Progress progress,Cancel cancel)throws Exception{
        byte[] buffer=new byte[256*1024];long done=0;MessageDigest head=digest();
        try(ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(output,256*1024))){
            zip.setLevel(1);
            zip.putNextEntry(new ZipEntry(HEADER));
            header(new DataOutputStream(new java.security.DigestOutputStream(zip,head)),m);zip.closeEntry();
            for(int i=0;i<m.entries.size();i++){
                Entry e=m.entries.get(i);check(cancel);Path p=safe(data,e.path,false);
                if(e.type==0){if(!Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS))throw new IOException("备份期间目录已变化");continue;}
                if(e.type==2){if(!Files.isSymbolicLink(p)||!Files.readSymbolicLink(p).toString().equals(e.link))throw new IOException("备份期间符号链接已变化");continue;}
                BasicFileAttributes before=Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
                if(!before.isRegularFile()||before.size()!=e.size||before.lastModifiedTime().toMillis()!=e.mtime)throw new IOException("备份期间文件已变化，请稍后重试");
                MessageDigest hash=digest();zip.putNextEntry(new ZipEntry("data/"+i));long size=0;
                try(InputStream in=Files.newInputStream(p,LinkOption.NOFOLLOW_LINKS)){
                    int n;while((n=in.read(buffer))!=-1){check(cancel);if(n==0)continue;size+=n;if(size>e.size)throw new IOException("备份期间文件大小已变化");hash.update(buffer,0,n);zip.write(buffer,0,n);done+=n;progress.update("packing",done,m.total,e.path);}
                }
                if(size!=e.size||Files.getLastModifiedTime(p,LinkOption.NOFOLLOW_LINKS).toMillis()!=e.mtime)throw new IOException("备份期间文件已变化，请重试");
                e.sha=hash.digest();zip.closeEntry();
            }
            check(cancel);zip.putNextEntry(new ZipEntry(CHECKSUMS));DataOutputStream sums=new DataOutputStream(zip);
            sums.write(head.digest());sums.writeInt(m.entries.size());
            for(Entry e:m.entries)if(e.type==1)sums.write(e.sha);
            sums.flush();zip.closeEntry();zip.finish();
        }
    }
    private static ZipEntry next(ZipInputStream zip,String expected)throws IOException{
        ZipEntry e=zip.getNextEntry();if(e==null||e.isDirectory()||!e.getName().equals(expected))throw new IOException("备份包文件缺失、重复或顺序无效");return e;
    }
    Manifest verify(InputStream input,boolean stage,Progress progress,Cancel cancel)throws Exception{
        Path staging=work.resolve("stage");if(stage){if(exists(work.resolve("transaction")))throw new IOException("有待恢复的导入事务");delete(staging,QUIET,NEVER);Files.createDirectories(staging);}
        Manifest m;
        TailInput tail=new TailInput(input);
        BufferedInputStream buffered=new BufferedInputStream(tail,256*1024);
        try(ZipInputStream zip=new ZipInputStream(buffered)){
            next(zip,HEADER);MessageDigest headerHash=digest();
            DataInputStream h=new DataInputStream(new java.security.DigestInputStream(zip,headerHash));m=readHeader(h);
            if(h.read()!=-1)throw new IOException("备份头包含额外内容");zip.closeEntry();
            check(cancel);
            long required=BackupSpace.add(m.total,(long)m.entries.size()*4096);
            BackupSpace.Monitor space=null;
            if(stage){
                FileStore store=Files.getFileStore(staging);
                space=new BackupSpace.Monitor(required,()->new long[]{store.getUsableSpace(),store.getTotalSpace()});
                try{space.preflight();}catch(IOException e){throw new IOException("内部导入暂存空间不足："+e.getMessage(),e);}
                progress.update("capacity",required,space.available,Long.toString(space.reserve));
            }
            long done=0;byte[] buffer=new byte[256*1024];
            for(int i=0;i<m.entries.size();i++){
                Entry e=m.entries.get(i);check(cancel);
                if(e.type!=1)continue;
                next(zip,"data/"+i);MessageDigest hash=digest();long size=0;
                Path dst=stage?safe(staging,e.path,true):null;
                if(stage)Files.createDirectories(dst.getParent());
                FileChannel channel=stage?FileChannel.open(dst,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS):null;
                try(OutputStream out=stage?java.nio.channels.Channels.newOutputStream(channel):new OutputStream(){public void write(int v){} public void write(byte[] b,int o,int l){}}){
                    int n;while((n=zip.read(buffer))!=-1){check(cancel);if(n==0)continue;size+=n;if(size>e.size)throw new IOException("文件解压大小超过清单");hash.update(buffer,0,n);if(space!=null){try{space.beforeWrite(n,System.nanoTime()/1000000);}finally{progress.update("capacity",required,space.available,Long.toString(space.reserve));}}out.write(buffer,0,n);done+=n;progress.update(stage?"validating":"verifying",done,m.total,e.path);}
                    if(channel!=null)channel.force(true);
                }
                if(size!=e.size)throw new IOException("文件大小与清单不一致");e.sha=hash.digest();zip.closeEntry();
            }
            next(zip,CHECKSUMS);DataInputStream sums=new DataInputStream(zip);byte[] got=new byte[32];sums.readFully(got);
            if(!MessageDigest.isEqual(got,headerHash.digest())||sums.readInt()!=m.entries.size())throw new IOException("备份清单 SHA-256 校验失败");
            for(Entry e:m.entries)if(e.type==1){sums.readFully(got);if(!MessageDigest.isEqual(got,e.sha))throw new IOException("备份文件 SHA-256 校验失败");}
            if(sums.read()!=-1||zip.getNextEntry()!=null)throw new IOException("备份包有未声明的数据");
            while(buffered.read(buffer)!=-1)check(cancel);
            tail.checkEnd();
            if(stage){
                for(Entry e:m.entries)if(e.type==0)Files.createDirectories(safe(staging,e.path,true));
                // Links are materialized last. Payload writes never traverse a restored link.
                for(Entry e:m.entries)if(e.type==2){Path p=safe(staging,e.path,true);Files.createDirectories(p.getParent());Files.createSymbolicLink(p,Paths.get(e.link));}
            }
        }catch(Exception e){if(stage)delete(staging,QUIET,NEVER);throw e;}
        return m;
    }
    void checkStaged(Manifest m,Progress progress,Cancel cancel)throws Exception{
        long done=0;byte[] b=new byte[256*1024];Path staging=work.resolve("stage");
        Set<String> expected=new HashSet<>();
        for(Entry e:m.entries){String name=e.path;expected.add(name);while(name.contains("/")){name=name.substring(0,name.lastIndexOf('/'));expected.add(name);}}
        Files.walkFileTree(staging,new SimpleFileVisitor<Path>(){
            private void checkName(Path p)throws IOException{check(cancel);if(!p.equals(staging)&&!expected.contains(staging.relativize(p).toString().replace(File.separatorChar,'/')))throw new IOException("暂存目录出现清单之外的文件");}
            @Override public FileVisitResult preVisitDirectory(Path p,BasicFileAttributes a)throws IOException{checkName(p);return FileVisitResult.CONTINUE;}
            @Override public FileVisitResult visitFile(Path p,BasicFileAttributes a)throws IOException{checkName(p);return FileVisitResult.CONTINUE;}
        });
        for(Entry e:m.entries){
            check(cancel);Path p=safe(staging,e.path,false);
            if(e.type==0){if(!Files.isDirectory(p,LinkOption.NOFOLLOW_LINKS))throw new IOException("暂存目录被改动");continue;}
            if(e.type==2){if(!Files.isSymbolicLink(p)||!Files.readSymbolicLink(p).toString().equals(e.link))throw new IOException("暂存链接被改动");continue;}
            if(!Files.isRegularFile(p,LinkOption.NOFOLLOW_LINKS)||Files.size(p)!=e.size)throw new IOException("暂存文件被改动");
            MessageDigest h=digest();try(InputStream in=Files.newInputStream(p,LinkOption.NOFOLLOW_LINKS)){int n;while((n=in.read(b))!=-1){check(cancel);h.update(b,0,n);done+=n;progress.update("rechecking",done,m.total,e.path);}}
            if(!MessageDigest.isEqual(h.digest(),e.sha))throw new IOException("暂存文件 SHA-256 校验失败");
        }
    }
    /** Retain only the maximum EOCD/comment tail, so truncated ZIP directories cannot pass. */
    private static final class TailInput extends FilterInputStream {
        final byte[] tail=new byte[65557];int pos=0,used=0;long bytes=0;
        TailInput(InputStream in){super(in);}
        private void add(byte[] b,int off,int n){
            bytes+=n;if(n>=tail.length){System.arraycopy(b,off+n-tail.length,tail,0,tail.length);pos=0;used=tail.length;return;}
            int first=Math.min(n,tail.length-pos);System.arraycopy(b,off,tail,pos,first);
            if(first<n)System.arraycopy(b,off+first,tail,0,n-first);
            pos=(pos+n)%tail.length;used=Math.min(tail.length,used+n);
        }
        @Override public int read()throws IOException{int v=in.read();if(v>=0){byte[] b={(byte)v};add(b,0,1);}return v;}
        @Override public int read(byte[] b,int off,int n)throws IOException{int got=in.read(b,off,n);if(got>0)add(b,off,got);return got;}
        void checkEnd()throws IOException{
            byte[] b=new byte[used];int start=(pos-used+tail.length)%tail.length;
            for(int i=0;i<used;i++)b[i]=tail[(start+i)%tail.length];
            for(int i=used-22;i>=0;i--){
                if((b[i]&255)!=0x50||(b[i+1]&255)!=0x4b||(b[i+2]&255)!=5||(b[i+3]&255)!=6)continue;
                int comment=(b[i+20]&255)|((b[i+21]&255)<<8);
                if(i+22+comment!=used)continue;
                if(b[i+4]!=0||b[i+5]!=0||b[i+6]!=0||b[i+7]!=0)throw new IOException("不支持分卷备份");
                return;
            }
            throw new IOException("备份 ZIP 尾部不完整或附加了额外数据");
        }
    }
    private static Path safe(Path root,String rel,boolean creating)throws IOException{
        Path p=root.resolve(rel).normalize();if(!p.startsWith(root)||p.equals(root))throw new IOException("路径越界");
        Path a=p.getParent();while(a!=null&&a.startsWith(root)){if(Files.isSymbolicLink(a)||exists(a)&&!Files.isDirectory(a,LinkOption.NOFOLLOW_LINKS))throw new IOException("父目录不能是符号链接或文件");a=a.getParent();}
        return p;
    }
    private List<String> targets(Manifest m)throws IOException{
        Set<String> names=new TreeSet<>();
        for(Path p:roots())names.add(data.relativize(p).toString().replace(File.separatorChar,'/'));
        for(Entry e:m.entries){String[] v=e.path.split("/");names.add(v[0].equals("files")?"files/"+v[1]:v[0]);}
        return new ArrayList<>(names);
    }
    private void writeJournal(List<String> targets,List<Boolean> had,boolean committed)throws IOException{
        Files.createDirectories(work);
        Path tmp=work.resolve("transaction.tmp");
        try(FileOutputStream f=new FileOutputStream(tmp.toFile());DataOutputStream out=new DataOutputStream(f)){
            string(out,MAGIC);out.writeBoolean(committed);out.writeInt(targets.size());
            for(int i=0;i<targets.size();i++){string(out,targets.get(i));out.writeBoolean(had.get(i));}out.flush();f.getFD().sync();
        }
        Files.move(tmp,work.resolve("transaction"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);sync(work);
    }
    private static void sync(Path dir)throws IOException{
        try(FileChannel f=FileChannel.open(dir,StandardOpenOption.READ)){f.force(true);}
    }
    private static void move(Path a,Path b)throws IOException{
        Files.createDirectories(b.getParent());Files.move(a,b,StandardCopyOption.ATOMIC_MOVE);sync(a.getParent());if(!a.getParent().equals(b.getParent()))sync(b.getParent());
    }
    void commit(Manifest m,Progress progress,Fault fault)throws Exception{
        Path staging=work.resolve("stage"),old=work.resolve("old");if(exists(work.resolve("transaction")))throw new IOException("导入事务尚未收尾");
        List<String> names=targets(m);List<Boolean> had=new ArrayList<>();for(String n:names)had.add(exists(safe(data,n,false)));
        // Set executable bits and timestamps only after all staged files were revalidated.
        for(int i=m.entries.size()-1;i>=0;i--){Entry e=m.entries.get(i);if(e.type!=2){Path p=safe(staging,e.path,false);chmod(p,e.mode);Files.setLastModifiedTime(p,FileTime.fromMillis(e.mtime));}}
        writeJournal(names,had,false);
        try{
            for(int i=0;i<names.size();i++){
                String n=names.get(i);Path dst=safe(data,n,false),src=safe(staging,n,false);
                if(had.get(i))move(dst,old.resolve(n));
                if(fault!=null)fault.checkpoint("old-moved",n);
                if(exists(src))move(src,dst);
                if(fault!=null)fault.checkpoint("new-installed",n);
                progress.update("applying",i+1,names.size(),n);
            }
            writeJournal(names,had,true);
        }catch(Exception e){recover();throw e;}
    }
    /** Must run before any preferences, databases, gateway or updater are opened. Only renames; no large deletion. */
    boolean recover()throws IOException{
        Path journal=work.resolve("transaction");if(!exists(journal))return false;
        List<String> names=new ArrayList<>();List<Boolean> had=new ArrayList<>();boolean committed;
        try(DataInputStream in=new DataInputStream(Files.newInputStream(journal))){
            if(!string(in).equals(MAGIC))throw new IOException("恢复日志损坏");committed=in.readBoolean();int count=in.readInt();if(count<0||count>100000)throw new IOException("恢复日志无效");
            Set<String> unique=new HashSet<>();
            for(int i=0;i<count;i++){String p=string(in);if(!allowed(p)||!(p.equals("databases")||p.equals("shared_prefs")||p.startsWith("files/")&&p.split("/").length==2)||!unique.add(p))throw new IOException("恢复日志路径无效");names.add(p);had.add(in.readBoolean());}
            if(in.read()!=-1)throw new IOException("恢复日志有额外数据");
        }
        if(committed)return true;
        for(int i=names.size()-1;i>=0;i--){
            String n=names.get(i);Path dst=safe(data,n,false),old=work.resolve("old").resolve(n),failed=work.resolve("failed").resolve(n);
            if(had.get(i)){
                if(exists(old)){if(exists(dst))move(dst,failed);move(old,dst);}
                else if(!exists(dst))throw new IOException("导入回滚缺少原目录："+n);
            }else if(exists(dst))move(dst,failed);
        }
        Files.delete(journal);sync(work);return false;
    }
    void cleanup(Progress progress,Cancel cancel)throws IOException{
        // Recover before deleting anything which might be the sole copy of the old environment.
        recover();delete(work.resolve("old"),progress,cancel);delete(work.resolve("stage"),progress,cancel);delete(work.resolve("failed"),progress,cancel);
        Files.deleteIfExists(work.resolve("transaction"));Files.deleteIfExists(work.resolve("transaction.tmp"));Files.deleteIfExists(work.resolve("ui-ready"));
    }
    static void delete(Path p,Progress progress,Cancel cancel)throws IOException{
        if(!exists(p))return;long[] done={0};
        Files.walkFileTree(p,new SimpleFileVisitor<Path>(){
            @Override public FileVisitResult preVisitDirectory(Path d,BasicFileAttributes a)throws IOException{check(cancel);if(!Files.isSymbolicLink(d))chmod(d,0700);return FileVisitResult.CONTINUE;}
            @Override public FileVisitResult visitFile(Path f,BasicFileAttributes a)throws IOException{check(cancel);Files.delete(f);progress.update("cleaning",++done[0],0,"");return FileVisitResult.CONTINUE;}
            @Override public FileVisitResult postVisitDirectory(Path d,IOException e)throws IOException{if(e!=null)throw e;check(cancel);Files.delete(d);return FileVisitResult.CONTINUE;}
        });
    }
}

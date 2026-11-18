package cc.codroid;
import java.io.*;import java.nio.file.*;import java.security.*;import java.util.*;import java.util.zip.*;
public final class FullBackupTest {
    static int count;
    interface Test {void run()throws Exception;}
    static void test(String name,Test t)throws Exception{t.run();System.out.println("PASS "+(++count)+" "+name);}
    static void check(boolean x){if(!x)throw new AssertionError();}
    static void failure(Test t)throws Exception{boolean failed=false;try{t.run();}catch(Exception e){failed=true;}check(failed);}
    static void put(Path root,String name,String text)throws Exception{Path p=root.resolve(name);Files.createDirectories(p.getParent());Files.write(p,text.getBytes("UTF-8"));}
    static String text(Path root,String name)throws Exception{return new String(Files.readAllBytes(root.resolve(name)),"UTF-8");}
    static byte[] rewrite(byte[] archive,String entry,byte[] replacement)throws Exception{
        ByteArrayOutputStream raw=new ByteArrayOutputStream();
        try(ZipInputStream in=new ZipInputStream(new ByteArrayInputStream(archive));ZipOutputStream out=new ZipOutputStream(raw)){
            ZipEntry e;byte[] buf=new byte[32768];while((e=in.getNextEntry())!=null){out.putNextEntry(new ZipEntry(e.getName()));if(e.getName().equals(entry))out.write(replacement);else{int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);}out.closeEntry();}
        }return raw.toByteArray();
    }
    static byte[] zipEntry(byte[] archive,String name)throws Exception{
        try(ZipInputStream in=new ZipInputStream(new ByteArrayInputStream(archive))){
            ZipEntry e;while((e=in.getNextEntry())!=null)if(e.getName().equals(name))return in.readAllBytes();
        }throw new IOException("missing fixture entry "+name);
    }
    static void copyField(DataInputStream in,DataOutputStream out)throws Exception{
        int n=in.readInt();byte[] b=new byte[n];in.readFully(b);out.writeInt(n);out.write(b);
    }
    // Produce the original format-1 bytes and a valid header digest, not a mock reader.
    static byte[] legacyArchive(byte[] archive)throws Exception{
        byte[] header=zipEntry(archive,FullBackup.HEADER);ByteArrayOutputStream raw=new ByteArrayOutputStream();
        DataInputStream in=new DataInputStream(new ByteArrayInputStream(header));DataOutputStream out=new DataOutputStream(raw);
        copyField(in,out);check(in.readInt()==2);out.writeInt(1);
        for(int i=0;i<3;i++)copyField(in,out);out.writeInt(in.readInt());
        int nameLength=in.readInt();in.skipNBytes(nameLength);out.write(in.readAllBytes());out.flush();
        byte[] oldHeader=raw.toByteArray(),sums=zipEntry(archive,FullBackup.CHECKSUMS);
        System.arraycopy(MessageDigest.getInstance("SHA-256").digest(oldHeader),0,sums,0,32);
        return rewrite(rewrite(archive,FullBackup.HEADER,oldHeader),FullBackup.CHECKSUMS,sums);
    }
    public static void main(String[] args)throws Exception{
        Path dir=Files.createTempDirectory("full-backup-test-"),data=dir.resolve("data"),work=dir.resolve("work");Files.createDirectories(data);
        FullBackup b=new FullBackup(data,work,"cc.codroid","aarch64");
        put(data,"files/home/.codex/auth.json","fixture-auth");put(data,"files/home/.codex/state.sqlite","fixture-db");
        put(data,"files/home/.bashrc","export EXAMPLE=fixture");put(data,"files/home/workspace/你好.txt","project");
        put(data,"files/usr/bin/tool","executable");data.resolve("files/usr/bin/tool").toFile().setExecutable(true);
        put(data,"files/usr/tmp/not-saved","temp");put(data,"files/app/server.mjs","current-apk");
        put(data,"shared_prefs/ui.xml","fixture-ui");put(data,"shared_prefs/consent.xml","sensitive-grant");
        put(data,"files/home/.gateway-token","transport-secret");put(data,"databases/native.db","native-db");
        Path outside=dir.resolve("outside");Files.createDirectories(outside);put(outside,"secret","outside-not-followed");
        Files.createSymbolicLink(data.resolve("files/home/link"),outside);
        FullBackup.Manifest m=b.scan(134,"0.7.7+fixture",FullBackup.QUIET,FullBackup.NEVER);
        ByteArrayOutputStream buf=new ByteArrayOutputStream();b.exportTo(buf,m,FullBackup.QUIET,FullBackup.NEVER);byte[] archive=buf.toByteArray();
        try{
            test("full private environment exports auth, databases, projects, permissions and links without following external targets",()->{
                check(m.entries.stream().anyMatch(e->e.path.endsWith("auth.json")));
                check(m.entries.stream().noneMatch(e->e.path.contains("server.mjs")||e.path.contains("consent.xml")||e.path.endsWith(".gateway-token")||e.path.contains("not-saved")));
                check(m.entries.stream().noneMatch(e->e.path.endsWith("/secret")));check(m.total>0);
            });
            test("valid ZIP and per-file SHA-256 verify without loading the payload in memory",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),false,FullBackup.QUIET,FullBackup.NEVER);check(v.total==m.total);check(v.entries.size()==m.entries.size());
            });
            test("format 2 persists complete app version and existing provenance under the header checksum",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),false,FullBackup.QUIET,FullBackup.NEVER);
                check(v.appVersion==134&&v.appVersionName.equals("0.7.7+fixture"));
                check(v.created==m.created&&v.pkg.equals(m.pkg)&&v.arch.equals(m.arch)&&v.dataPath.equals(m.dataPath));
                byte[] header=zipEntry(archive,FullBackup.HEADER);
                // Change only ASCII bytes: binary fields must remain byte-for-byte intact.
                byte[] changed=header.clone(),needle="0.7.7+fixture".getBytes("UTF-8");
                for(int i=0;i<=changed.length-needle.length;i++)if(Arrays.equals(Arrays.copyOfRange(changed,i,i+needle.length),needle)){changed[i+needle.length-1]='x';break;}
                byte[] bad=rewrite(archive,FullBackup.HEADER,changed);
                failure(()->b.verify(new ByteArrayInputStream(bad),true,FullBackup.QUIET,FullBackup.NEVER));
                check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));
            });
            test("original format-1 backups still verify and stage with explicitly unknown version name",()->{
                byte[] old=legacyArchive(archive);
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(old),true,FullBackup.QUIET,FullBackup.NEVER);
                check(v.appVersion==134&&v.appVersionName.isEmpty()&&v.created==m.created&&v.total==m.total);
                b.checkStaged(v,FullBackup.QUIET,FullBackup.NEVER);b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
                check(BackupUi.importWarning(134,v.appVersionName,134,"0.7.7+fixture").contains("未记录版本名"));
                check(BackupUi.importWaitMillis(134,v.appVersionName,134,"0.7.7+fixture")==15000);
            });
            test("confirmation compares code and name and always explains irreversible current-data replacement",()->{
                String same=BackupUi.importWarning(134,"0.7.7+fixture",134,"0.7.7+fixture");
                check(same.contains("版本一致")&&same.contains("会话记录")&&same.contains("工具临时目录")&&same.contains("无法通过取消撤销"));
                check(BackupUi.importWaitMillis(134,"0.7.7+fixture",134,"0.7.7+fixture")==10000);
                String older=BackupUi.importWarning(133,"old-version",134,"current-version");
                check(older.contains("版本不一致")&&older.contains("备份版本：old-version（构建 133）")&&older.contains("当前版本：current-version（构建 134）"));
                check(older.contains("数据丢失")&&older.contains("工具损坏")&&older.contains("15 秒"));
                check(BackupUi.versionMismatch(134,"different-name",134,"current-version"));
                check(BackupUi.importWaitMillis(134,"different-name",134,"current-version")==15000);
                check(!BackupUi.versionMismatch(134,"current-version",134,"current-version"));
                check(BackupUi.importWarning(133,"",134,"current-version").contains("版本不一致"));
            });
            test("newer app builds remain blocked with both versions shown before any replacement",()->{
                FullBackup older=new FullBackup(data,work,"cc.codroid","aarch64",133,"current-older");
                try{older.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);throw new AssertionError("newer backup accepted");}
                catch(IOException e){check(e.getMessage().contains("备份版本：0.7.7+fixture（构建 134）"));check(e.getMessage().contains("当前版本：current-older（构建 133）"));}
                check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));
                check(!FullBackup.exists(work.resolve("stage")));
            });
            test("invalid version metadata is rejected rather than injecting dialog text",()->{
                failure(()->b.scan(134,"fake\nversion",FullBackup.QUIET,FullBackup.NEVER));
                failure(()->b.scan(134,String.join("",Collections.nCopies(257,"x")),FullBackup.QUIET,FullBackup.NEVER));
                byte[] header=zipEntry(archive,FullBackup.HEADER);
                java.nio.ByteBuffer.wrap(header).putInt(4+FullBackup.MAGIC.getBytes("UTF-8").length,3);
                byte[] future=rewrite(archive,FullBackup.HEADER,header);
                failure(()->b.verify(new ByteArrayInputStream(future),false,FullBackup.QUIET,FullBackup.NEVER));
            });
            test("staging does not overwrite current data; confirmed commit restores full state and keeps current APK",()->{
                put(data,"files/home/.codex/auth.json","new-current-account");put(data,"files/home/new-only","must disappear on full restore");
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);
                check(text(data,"files/home/.codex/auth.json").equals("new-current-account"));
                b.checkStaged(v,FullBackup.QUIET,FullBackup.NEVER);b.commit(v,FullBackup.QUIET,null);b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
                check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));check(!FullBackup.exists(data.resolve("files/home/new-only")));
                check(text(data,"files/app/server.mjs").equals("current-apk"));check(!FullBackup.exists(data.resolve("shared_prefs/consent.xml")));
                check(Files.isExecutable(data.resolve("files/usr/bin/tool")));check(Files.readSymbolicLink(data.resolve("files/home/link")).equals(outside));
            });
            test("payload tampering with a valid ZIP CRC is caught by SHA-256 before any overwrite",()->{
                int index=0;for(;index<m.entries.size();index++)if(m.entries.get(index).type==1)break;
                FullBackup.Entry e=m.entries.get(index);byte[] changed=new byte[(int)e.size];Arrays.fill(changed,(byte)'x');
                byte[] bad=rewrite(archive,"data/"+index,changed);
                failure(()->b.verify(new ByteArrayInputStream(bad),true,FullBackup.QUIET,FullBackup.NEVER));check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));
            });
            test("truncated and wrong-architecture packages are rejected",()->{
                failure(()->b.verify(new ByteArrayInputStream(Arrays.copyOf(archive,archive.length/2)),true,FullBackup.QUIET,FullBackup.NEVER));
                failure(()->b.verify(new ByteArrayInputStream(Arrays.copyOf(archive,archive.length-8)),true,FullBackup.QUIET,FullBackup.NEVER));
                FullBackup older=new FullBackup(data,work,"cc.codroid","aarch64",133);
                failure(()->older.verify(new ByteArrayInputStream(archive),false,FullBackup.QUIET,FullBackup.NEVER));
                FullBackup other=new FullBackup(data,work,"different.pkg","aarch64");
                failure(()->other.verify(new ByteArrayInputStream(archive),false,FullBackup.QUIET,FullBackup.NEVER));
            });
            test("a changed staged auth file fails the final recheck",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);
                put(work,"stage/files/home/.codex/auth.json","changed-auth");
                failure(()->b.checkStaged(v,FullBackup.QUIET,FullBackup.NEVER));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });
            test("cancel during archive processing leaves current files unchanged",()->{
                final boolean[] stop={false};
                failure(()->b.verify(new ByteArrayInputStream(archive),true,(p,d,t,n)->stop[0]=true,()->stop[0]));
                check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });
            test("I/O failure during directory replacement rolls back automatically",()->{
                put(data,"files/home/.codex/auth.json","before-failed-restore");
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);
                failure(()->b.commit(v,FullBackup.QUIET,(step,p)->{throw new RuntimeException("simulated I/O failure");}));
                check(text(data,"files/home/.codex/auth.json").equals("before-failed-restore"));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });
            test("process death between renames recovers original data before startup and recovery is idempotent",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);
                boolean crashed=false;try{b.commit(v,FullBackup.QUIET,(step,p)->{if(step.equals("old-moved")&&p.equals("files/home"))throw new AssertionError("process died");});}catch(AssertionError e){crashed=true;}check(crashed);
                new FullBackup(data,work,"cc.codroid","aarch64").recover();b.recover();
                check(text(data,"files/home/.codex/auth.json").equals("before-failed-restore"));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });

            test("a newly installed root is removed on crash rollback",()->{
                put(data,"files/new-environment/info","newly-backed");
                FullBackup.Manifest newer=b.scan(134,FullBackup.QUIET,FullBackup.NEVER);
                ByteArrayOutputStream packed=new ByteArrayOutputStream();b.exportTo(packed,newer,FullBackup.QUIET,FullBackup.NEVER);
                FullBackup.delete(data.resolve("files/new-environment"),FullBackup.QUIET,FullBackup.NEVER);
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(packed.toByteArray()),true,FullBackup.QUIET,FullBackup.NEVER);
                boolean crashed=false;
                try{b.commit(v,FullBackup.QUIET,(step,p)->{if(step.equals("new-installed")&&p.equals("files/new-environment"))throw new AssertionError("process died after new root");});}
                catch(AssertionError e){crashed=true;}
                check(crashed);b.recover();check(!FullBackup.exists(data.resolve("files/new-environment")));
                check(text(data,"files/home/.codex/auth.json").equals("before-failed-restore"));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });
            test("a committed journal never rolls back a completed restore",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);b.commit(v,FullBackup.QUIET,null);
                b.recover();check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
            });
            test("path traversal, protected APK paths and symlink ancestors are rejected",()->{
                for(String name:new String[]{"files/home/../../outside","files/app/evil","/absolute","files/home//empty","shared_prefs/consent.xml"})check(!FullBackup.allowed(name));
                FullBackup.Manifest bad=new FullBackup.Manifest();bad.pkg=m.pkg;bad.arch=m.arch;bad.dataPath=m.dataPath;bad.created=m.created;bad.total=0;
                bad.entries.add(new FullBackup.Entry("files/home/link",(byte)2,0700,0,0,outside.toString()));
                bad.entries.add(new FullBackup.Entry("files/home/link/overwrite",(byte)1,0600,0,0,""));
                ByteArrayOutputStream zipbuf=new ByteArrayOutputStream();try(ZipOutputStream z=new ZipOutputStream(zipbuf)){z.putNextEntry(new ZipEntry(FullBackup.HEADER));FullBackup.header(new DataOutputStream(z),bad);z.closeEntry();}
                failure(()->b.verify(new ByteArrayInputStream(zipbuf.toByteArray()),true,FullBackup.QUIET,FullBackup.NEVER));
                check(text(outside,"secret").equals("outside-not-followed"));
            });

            test("undeclared staged files are rejected before directory replacement",()->{
                FullBackup.Manifest v=b.verify(new ByteArrayInputStream(archive),true,FullBackup.QUIET,FullBackup.NEVER);
                put(work,"stage/files/home/unlisted-script.sh","must-not-restore");
                failure(()->b.checkStaged(v,FullBackup.QUIET,FullBackup.NEVER));b.cleanup(FullBackup.QUIET,FullBackup.NEVER);
                check(!FullBackup.exists(data.resolve("files/home/unlisted-script.sh")));
            });

            test("final staging recheck can cancel inside a large file before any overwrite",()->{
                Path big=data.resolve("files/home/recheck-large-fixture");Files.write(big,new byte[1024*1024]);
                FullBackup.Manifest larger=b.scan(134,FullBackup.QUIET,FullBackup.NEVER);
                ByteArrayOutputStream out=new ByteArrayOutputStream();b.exportTo(out,larger,FullBackup.QUIET,FullBackup.NEVER);
                FullBackup.Manifest staged=b.verify(new ByteArrayInputStream(out.toByteArray()),true,FullBackup.QUIET,FullBackup.NEVER);
                boolean[] stop={false};long[] maximum={0};
                failure(()->b.checkStaged(staged,(p,d,t,n)->{if(n.contains("recheck-large-fixture")){maximum[0]=d;stop[0]=true;}},()->stop[0]));
                check(maximum[0]>0&&maximum[0]<1024*1024);check(text(data,"files/home/.codex/auth.json").equals("fixture-auth"));
                b.cleanup(FullBackup.QUIET,FullBackup.NEVER);Files.delete(big);
            });
            test("destination preflight includes metadata/reserve and rejects unknown or insufficient capacity",()->{
                long estimated=BackupSpace.estimate(m),reserve=BackupSpace.reserve(128*BackupSpace.GiB);
                check(estimated>=m.total&&estimated>=archive.length);
                BackupSpace.check(estimated+reserve,estimated,reserve);
                failure(()->BackupSpace.check(estimated+reserve-1,estimated,reserve));
                failure(()->BackupSpace.check(-1,estimated,reserve));
                check(BackupSpace.reserve(2*BackupSpace.GiB)==256*BackupSpace.MiB);
                check(BackupSpace.reserve(1024*BackupSpace.GiB)==4*BackupSpace.GiB);
                FullBackup.Manifest huge=new FullBackup.Manifest();huge.total=Long.MAX_VALUE;
                failure(()->BackupSpace.estimate(huge));
            });
            test("space is rechecked during writes and stops before crossing the reserve",()->{
                long[] free={10*BackupSpace.GiB};int[] reads={0};
                BackupSpace.Monitor monitor=new BackupSpace.Monitor(2*BackupSpace.GiB,()->{reads[0]++;return new long[]{free[0],100*BackupSpace.GiB};});
                monitor.preflight();monitor.beforeWrite(1024,0);
                int read=reads[0];monitor.beforeWrite(1024,500);check(reads[0]==read);
                monitor.beforeWrite(1024,1100);check(reads[0]>read);
                free[0]=monitor.reserve;
                failure(()->monitor.beforeWrite((int)(8*BackupSpace.MiB),1200));
                failure(()->new BackupSpace.Monitor(10,()->null).preflight());
            });
            test("progress uses long byte counters and does not regress between known stages",()->{
                long big=5L*1024*1024*1024;
                check(BackupUi.percent("export","packing",big/2,big)==37);check(BackupUi.percent("export","verifying",0,big)==70);
                check(BackupUi.percent("import","validating",big,big)==80);check(BackupUi.percent("import","rechecking",0,big)==80);
                check(BackupUi.percent("import","applying",0,10)==90);check(BackupUi.percent("import","restored",0,0)==100);
                check(BackupUi.percent("export","scanning",1,0)==-1);check(BackupUi.percent("import","awaiting-confirmation",0,0)==80);check(BackupUi.bytes(big).equals("5.0 GiB"));
            });
            System.out.println(count+"/"+count+" full backup tests passed");
        }finally{FullBackup.delete(dir,FullBackup.QUIET,FullBackup.NEVER);}
    }
}

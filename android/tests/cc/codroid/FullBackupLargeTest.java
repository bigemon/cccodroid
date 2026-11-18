package cc.codroid;
import java.io.*;import java.nio.file.*;import java.security.*;import java.util.zip.*;
/** Real >4 GiB logical entry, with a 96 MiB heap and a small compressed fixture. */
public final class FullBackupLargeTest {
    public static void main(String[] args)throws Exception{
        Path root=Files.createTempDirectory("full-backup-zip64-"),data=root.resolve("data");Files.createDirectories(data);
        long size=(1L<<32)+12345;
        FullBackup.Manifest m=new FullBackup.Manifest();m.pkg="cc.codroid";m.arch="aarch64";m.dataPath=data.toRealPath().toString();m.appVersion=134;m.created=System.currentTimeMillis();m.total=size;
        m.entries.add(new FullBackup.Entry("files/home",(byte)0,0700,0,0,""));
        m.entries.add(new FullBackup.Entry("files/home/large.db",(byte)1,0600,size,0,""));
        Path archive=root.resolve("large.zip");long started=System.nanoTime();byte[] buffer=new byte[256*1024];
        try{
            MessageDigest header=MessageDigest.getInstance("SHA-256"),file=MessageDigest.getInstance("SHA-256");
            try(ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(Files.newOutputStream(archive),256*1024))){
                zip.setLevel(1);zip.putNextEntry(new ZipEntry(FullBackup.HEADER));
                FullBackup.header(new DataOutputStream(new java.security.DigestOutputStream(zip,header)),m);zip.closeEntry();
                zip.putNextEntry(new ZipEntry("data/1"));long written=0;
                while(written<size){int n=(int)Math.min(buffer.length,size-written);zip.write(buffer,0,n);file.update(buffer,0,n);written+=n;}zip.closeEntry();
                zip.putNextEntry(new ZipEntry(FullBackup.CHECKSUMS));DataOutputStream sums=new DataOutputStream(zip);sums.write(header.digest());sums.writeInt(2);sums.write(file.digest());sums.flush();zip.closeEntry();
            }
            final long[] maximum={0};
            try(InputStream in=Files.newInputStream(archive)){
                FullBackup.Manifest verified=new FullBackup(data,root.resolve("work"),m.pkg,m.arch).verify(in,false,(p,d,t,n)->maximum[0]=Math.max(maximum[0],d),FullBackup.NEVER);
                if(verified.total!=size||maximum[0]!=size)throw new AssertionError("long size/progress was truncated");
            }
            System.out.println("PASS ZIP64 "+size+" uncompressed bytes, archive "+Files.size(archive)+" bytes, max progress "+maximum[0]+", heap limit "+Runtime.getRuntime().maxMemory()+", elapsed "+((System.nanoTime()-started)/1000000)+" ms");
        }finally{FullBackup.delete(root,FullBackup.QUIET,FullBackup.NEVER);}
    }
}

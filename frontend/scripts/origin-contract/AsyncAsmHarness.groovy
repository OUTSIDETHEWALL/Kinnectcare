import org.objectweb.asm.*
import java.util.jar.JarFile

// Same visitor body as the AGP plugin, against actual RN release class bytes.
// Only AGP interface/parameter types are replaced for standalone execution.
def source = new File(args[0]).text
source = source.substring(0, source.indexOf('androidComponents.onVariants'))
source = source.replace('abstract class KinnshipDeepAsyncFactory implements com.android.build.api.instrumentation.AsmClassVisitorFactory<com.android.build.api.instrumentation.InstrumentationParameters.None>', 'class KinnshipDeepAsyncFactory')
source = source.replace('com.android.build.api.instrumentation.ClassData', 'Object')
source = source.replace('com.android.build.api.instrumentation.ClassContext', 'Object')
def loader = new GroovyClassLoader(getClass().classLoader)
def factory = loader.parseClass(source).getDeclaredConstructor().newInstance()
def jar = new JarFile(args[1])
int classes = 0, calls = 0, responseCalls = 0, fileReaderCalls = 0
jar.entries().each { entry ->
  if (!entry.name.endsWith('.class')) return
  def name = entry.name.replace('/', '.').replace('.class', '')
  if (!factory.isInstrumentable([className: name])) return
  byte[] bytes = jar.getInputStream(entry).bytes
  def writer = new ClassWriter(ClassWriter.COMPUTE_MAXS)
  def visitor = factory.createClassVisitor([currentClassData: [className: name]], writer)
  new ClassReader(bytes).accept(visitor, ClassReader.EXPAND_FRAMES)
  new ClassReader(writer.toByteArray()).accept(new ClassVisitor(Opcodes.ASM9) {
    MethodVisitor visitMethod(int access, String n, String d, String s, String[] e) {
      new MethodVisitor(Opcodes.ASM9) {
        void visitMethodInsn(int op, String owner, String method, String desc, boolean itf) {
          if (owner == 'expo/modules/startupdiagnostics/DeepAsyncTrace') {
            calls++
            if (name == 'com.facebook.react.modules.network.ResponseUtil') responseCalls++
            if (name.startsWith('com.facebook.react.modules.blob.FileReaderModule')) fileReaderCalls++
          }
        }
      }
    }
  }, 0)
  classes++
}
assert classes == 3
assert responseCalls == 5
assert fileReaderCalls == 11
assert calls == 16
println "PASS actual RN class transformation: ${classes} classes, ${calls} passive observer calls"
println "Native response hooks: ${responseCalls} / 5; Native FileReader hooks: ${fileReaderCalls} / 11"
println 'LIMIT: AGP frame recomputation, shrinker and delivered DEX still require the native build.'

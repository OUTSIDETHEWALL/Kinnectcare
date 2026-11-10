import org.objectweb.asm.*
import java.util.jar.JarFile
// Execute the EXACT AGP visitor body against real RN classes and JVM fixtures.
def source = new File(args[0]).text
source = source.substring(0, source.indexOf('androidComponents.onVariants'))
source = source.replace('abstract class KinnshipMonitorFactory implements com.android.build.api.instrumentation.AsmClassVisitorFactory<com.android.build.api.instrumentation.InstrumentationParameters.None>', 'class KinnshipMonitorFactory')
source = source.replace('com.android.build.api.instrumentation.ClassData', 'Object')
source = source.replace('com.android.build.api.instrumentation.ClassContext', 'Object')
def factory = new GroovyClassLoader(getClass().classLoader).parseClass(source).getDeclaredConstructor().newInstance()
int calls = 0, classes = 0
def transform = { byte[] bytes, boolean frames ->
  def writer = new ClassWriter(frames ? ClassWriter.COMPUTE_FRAMES : ClassWriter.COMPUTE_MAXS) {
    protected String getCommonSuperClass(String a, String b) { return 'java/lang/Object' }
  }
  def visitor = factory.createClassVisitor([currentClassData:[className:new ClassReader(bytes).className.replace('/','.')]], writer)
  new ClassReader(bytes).accept(visitor, ClassReader.EXPAND_FRAMES)
  def result = writer.toByteArray()
  new ClassReader(result).accept(new ClassVisitor(Opcodes.ASM9) {
    MethodVisitor visitMethod(int a, String n, String d, String s, String[] e) {
      new MethodVisitor(Opcodes.ASM9) {
        void visitMethodInsn(int op, String owner, String method, String desc, boolean itf) {
          if (owner == 'com/facebook/react/runtime/SchedulingProbe' && method == 'hold') calls++
        }
      }
    }
  }, 0)
  result
}
new JarFile(args[1]).withCloseable { jar ->
  jar.entries().each { entry ->
    if (entry.name.endsWith('.class') && entry.name.startsWith('com/facebook/react/')) {
      def bytes = jar.getInputStream(entry).bytes
      // Only inspect classes that have an actual invocation of the monitored API.
      if (!new String(bytes, 'ISO-8859-1').contains('HeadlessJsTaskContext')) return
      transform(bytes, false); classes++
    }
  }
}
assert calls > 0
def file = new File(args[2])
file.bytes = transform(file.bytes, true)
def tree = new org.objectweb.asm.tree.ClassNode()
new ClassReader(file.bytes).accept(tree, 0)
def main = tree.methods.find { it.name == 'main' }
def originalCatch = main.tryCatchBlocks.find { it.type == 'java/lang/IllegalArgumentException' }
assert originalCatch != null
assert originalCatch.visibleTypeAnnotations?.any { it.desc.contains('Marker') }
originalCatch.visibleTypeAnnotations.each { annotation ->
  assert new TypeReference(annotation.typeRef).tryCatchBlockIndex == main.tryCatchBlocks.indexOf(originalCatch)
}
println "PASS exact AGP monitor visitor: ${classes} RN classes inspected, ${calls} guarded invocations; JVM fixture frames recomputed"
println 'PASS original exception type annotation retained on its correctly remapped handler'
println 'LIMIT: delivered AGP/R8/Dex coverage remains an artifact gate.'

# Local builds only (never committed): run React Native's bundler without the PostHog
# sourcemap wrapper, which needs PostHog CLI credentials this machine doesn't have.
import re
p='Editify.xcodeproj/project.pbxproj'
s=open(p).read()
s2=re.sub(r'`\\"\$NODE_BINARY\\" --print \\"require\(\'path\'\)\.join\(require\(\'path\'\)\.dirname\(require\.resolve\(\'posthog-react-native\'\)\), \'\.\.\', \'tooling\', \'posthog-xcode\.sh\'\)\\"` ', '', s)
assert s2 != s, 'posthog wrapper not found'
open(p,'w').write(s2)
# And skip the dSYM upload phase (same credentials).
s=open(p).read()
s3=s.replace('PODS_SCRIPT=\\"${PODS_ROOT}/PostHog/build-tools/upload-symbols.sh\\"', 'PODS_SCRIPT=\\"/nonexistent/local-build-skips-upload\\"')
s3=s3.replace('SPM_SCRIPT=\\"${BUILD_DIR%/Build/*}/SourcePackages/checkouts/posthog-ios/build-tools/upload-symbols.sh\\"', 'SPM_SCRIPT=\\"/nonexistent/local-build-skips-upload\\"')
assert s3 != s, 'dSYM phase not found'
open(p,'w').write(s3)

// EditifyEngine is built against the EditifyCore pod. This one re-export makes Core's public
// types visible to every Engine file (and to the generated Expo module provider). The macOS
// harnesses compile Core and Engine sources into one module and leave this file out.
@_exported import EditifyCore

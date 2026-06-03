import type { GetServerSidePropsContext } from 'next'

/**
 * The workbench is now scene-scoped at /workbench/[sceneId]. The bare
 * /workbench path redirects to the scene list (first layer of the module).
 */
export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
  return { redirect: { destination: '/scenes', permanent: false } }
}

export default function WorkbenchRedirect() {
  return null
}

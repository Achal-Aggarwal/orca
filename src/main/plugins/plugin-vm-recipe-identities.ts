import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginVmRecipeIdentities } from '../../shared/plugins/approval/plugin-update-access-growth'
import {
  listPluginVmRecipeCommands,
  parsePluginVmRecipeArtifact
} from '../../shared/plugins/artifacts/plugin-vm-recipe-artifact'
import {
  PLUGIN_VM_RECIPE_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'

/** What each declared recipe can run, so an update compares commands rather than file paths.
 *  Null when any file cannot be read, which makes the update count its recipes as new. */
export async function readPluginVmRecipeIdentities(
  rootDir: string,
  manifest: Pick<PluginManifest, 'contributes'>
): Promise<PluginVmRecipeIdentities> {
  try {
    const identities: string[] = []
    for (const contribution of manifest.contributes.vmRecipes ?? []) {
      const artifact = parsePluginVmRecipeArtifact(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_VM_RECIPE_MAX_BYTES
        )
      )
      identities.push(
        JSON.stringify(
          artifact.kind === 'recipe'
            ? [
                artifact.recipe.id,
                artifact.recipe.checkoutMode ?? null,
                listPluginVmRecipeCommands(artifact.recipe)
              ]
            : [artifact.provider.id, 'machine-provider', artifact.provider.command]
        )
      )
    }
    return identities
  } catch {
    return null
  }
}

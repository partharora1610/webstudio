import { nanoid } from "nanoid";
import { toast } from "@webstudio-is/design-system";
import { equalMedia, type StyleValue } from "@webstudio-is/css-engine";
import {
  type Instance,
  type Instances,
  type StyleSource,
  getStyleDeclKey,
  findTreeInstanceIds,
  StyleSourceSelection,
  StyleDecl,
  Asset,
  StyleSources,
  Breakpoints,
  DataSources,
  Props,
  DataSource,
  Breakpoint,
  type WebstudioFragment,
  type WebstudioData,
  type Resource,
  findTreeInstanceIdsExcludingSlotDescendants,
} from "@webstudio-is/sdk";
import {
  type WsComponentMeta,
  generateDataFromEmbedTemplate,
  decodeDataSourceVariable,
  validateExpression,
  encodeDataSourceVariable,
  portalComponent,
  collectionComponent,
} from "@webstudio-is/react-sdk";
import {
  $props,
  $styles,
  $selectedInstanceSelector,
  $styleSourceSelections,
  $styleSources,
  $instances,
  $registeredComponentMetas,
  $dataSources,
  $assets,
  $project,
  $breakpoints,
  $pages,
  $resources,
} from "./nano-states";
import {
  type DroppableTarget,
  type InstanceSelector,
  findLocalStyleSourcesWithinInstances,
  getAncestorInstanceSelector,
  insertPropsCopyMutable,
  getReparentDropTargetMutable,
  getInstanceOrCreateFragmentIfNecessary,
  wrapEditableChildrenAroundDropTargetMutable,
} from "./tree-utils";
import { removeByMutable } from "./array-utils";
import { isBaseBreakpoint } from "./breakpoints";
import { humanizeString } from "./string-utils";
import { serverSyncStore } from "./sync";

export const updateWebstudioData = (mutate: (data: WebstudioData) => void) => {
  serverSyncStore.createTransaction(
    [
      $pages,
      $instances,
      $props,
      $breakpoints,
      $styleSourceSelections,
      $styleSources,
      $styles,
      $dataSources,
      $resources,
      $assets,
    ],
    (
      pages,
      instances,
      props,
      breakpoints,
      styleSourceSelections,
      styleSources,
      styles,
      dataSources,
      resources,
      assets
    ) => {
      // @todo normalize pages
      if (pages === undefined) {
        return;
      }
      mutate({
        pages,
        instances,
        props,
        dataSources,
        resources,
        breakpoints,
        styleSourceSelections,
        styleSources,
        styles,
        assets,
      });
    }
  );
};

export const getWebstudioData = (): WebstudioData => {
  const pages = $pages.get();
  if (pages === undefined) {
    throw Error(`Cannot get webstudio data with empty pages`);
  }
  return {
    pages,
    instances: $instances.get(),
    props: $props.get(),
    dataSources: $dataSources.get(),
    resources: $resources.get(),
    breakpoints: $breakpoints.get(),
    styleSourceSelections: $styleSourceSelections.get(),
    styleSources: $styleSources.get(),
    styles: $styles.get(),
    assets: $assets.get(),
  };
};

const getLabelFromComponentName = (component: Instance["component"]) => {
  if (component.includes(":")) {
    // strip namespace
    const [_namespace, baseName] = component.split(":");
    component = baseName;
  }
  return humanizeString(component);
};

export const getInstanceLabel = (
  instance: { component: string; label?: string },
  meta: WsComponentMeta
) => {
  return (
    instance.label ||
    meta.label ||
    getLabelFromComponentName(instance.component)
  );
};

export const findClosestEditableInstanceSelector = (
  instanceSelector: InstanceSelector,
  instances: Instances,
  metas: Map<string, WsComponentMeta>
) => {
  for (const instanceId of instanceSelector) {
    const instance = instances.get(instanceId);
    if (instance === undefined) {
      return;
    }
    // when start editing empty body all text content
    // including style and scripts appear in editor
    // assume body is root and stop checking further
    if (instance.component === "Body") {
      return;
    }
    const meta = metas.get(instance.component);
    if (meta === undefined) {
      return;
    }
    if (meta.type !== "container") {
      continue;
    }
    // only container with rich-text-child children and text can be edited
    for (const child of instance.children) {
      if (child.type === "id") {
        const childInstance = instances.get(child.value);
        if (childInstance === undefined) {
          return;
        }
        const childMeta = metas.get(childInstance.component);
        if (childMeta?.type !== "rich-text-child") {
          return;
        }
      }
    }
    return getAncestorInstanceSelector(instanceSelector, instanceId);
  }
};

export const findClosestDetachableInstanceSelector = (
  instanceSelector: InstanceSelector,
  instances: Instances,
  metas: Map<string, WsComponentMeta>
) => {
  for (const instanceId of instanceSelector) {
    const instance = instances.get(instanceId);
    if (instance === undefined) {
      return;
    }
    const meta = metas.get(instance.component);
    if (meta === undefined) {
      return;
    }
    const detachable = meta.detachable ?? true;
    if (meta.type === "rich-text-child" || detachable === false) {
      continue;
    }
    return getAncestorInstanceSelector(instanceSelector, instanceId);
  }
};

export const isInstanceDetachable = (
  instances: Instances,
  instanceSelector: InstanceSelector
) => {
  const metas = $registeredComponentMetas.get();
  const [instanceId] = instanceSelector;
  const instance = instances.get(instanceId);
  if (instance === undefined) {
    return false;
  }
  const meta = metas.get(instance.component);
  if (meta === undefined) {
    return false;
  }
  return meta.detachable ?? true;
};

const traverseInstancesConstraints = (
  metas: Map<string, WsComponentMeta>,
  instances: Instances,
  instanceId: Instance["id"],
  requiredAncestors: Set<Instance["component"]>,
  invalidAncestors: Set<Instance["component"]>,
  componentSelector: string[] = []
) => {
  const instance = instances.get(instanceId);
  if (instance === undefined) {
    return;
  }
  const meta = metas.get(instance.component);
  if (meta === undefined) {
    return;
  }
  if (meta.requiredAncestors) {
    for (const requiredAncestor of meta.requiredAncestors) {
      if (componentSelector.includes(requiredAncestor) === false) {
        requiredAncestors.add(requiredAncestor);
      }
    }
  }
  if (meta.invalidAncestors) {
    for (const invalidAncestor of meta.invalidAncestors) {
      invalidAncestors.add(invalidAncestor);
    }
  }
  for (const child of instance.children) {
    if (child.type === "id") {
      traverseInstancesConstraints(
        metas,
        instances,
        child.value,
        requiredAncestors,
        invalidAncestors,
        [instance.component, ...componentSelector]
      );
    }
  }
};

export type InsertConstraints = {
  requiredAncestors: Set<Instance["component"]>;
  invalidAncestors: Set<Instance["component"]>;
};

export const computeInstancesConstraints = (
  metas: Map<string, WsComponentMeta>,
  instances: Instances,
  rootInstanceIds: Instance["id"][]
): InsertConstraints => {
  const requiredAncestors = new Set<string>();
  const invalidAncestors = new Set<string>();
  for (const instanceId of rootInstanceIds) {
    traverseInstancesConstraints(
      metas,
      instances,
      instanceId,
      requiredAncestors,
      invalidAncestors
    );
  }
  return {
    requiredAncestors,
    invalidAncestors,
  };
};

export const findClosestDroppableComponentIndex = (
  metas: Map<string, WsComponentMeta>,
  componentSelector: string[],
  constraints: InsertConstraints
) => {
  const { requiredAncestors, invalidAncestors } = constraints;

  let containerIndex = -1;
  let requiredFound = false;
  for (let index = 0; index < componentSelector.length; index += 1) {
    const ancestorComponent = componentSelector[index];
    if (invalidAncestors.has(ancestorComponent) === true) {
      containerIndex = -1;
      requiredFound = false;
      continue;
    }
    if (requiredAncestors.has(ancestorComponent) === true) {
      requiredFound = true;
    }
    const ancestorMeta = metas.get(ancestorComponent);
    if (containerIndex === -1 && ancestorMeta?.type === "container") {
      containerIndex = index;
    }
  }

  if (requiredFound || requiredAncestors.size === 0) {
    return containerIndex;
  }
  return -1;
};

export const findClosestDroppableTarget = (
  metas: Map<string, WsComponentMeta>,
  instances: Instances,
  instanceSelector: InstanceSelector,
  insertConstraints: InsertConstraints
): undefined | DroppableTarget => {
  const componentSelector: string[] = [];
  for (const instanceId of instanceSelector) {
    const component = instances.get(instanceId)?.component;
    // collection produce fake instances
    // and fragment does not have constraints
    if (component === undefined) {
      componentSelector.push("Fragment");
      continue;
    }
    componentSelector.push(component);
  }

  const droppableIndex = findClosestDroppableComponentIndex(
    metas,
    componentSelector,
    insertConstraints
  );
  if (droppableIndex === -1) {
    return;
  }
  if (droppableIndex === 0) {
    return {
      parentSelector: instanceSelector,
      position: "end",
    };
  }

  const dropTargetSelector = instanceSelector.slice(droppableIndex);
  const dropTargetInstanceId = instanceSelector[droppableIndex];
  const dropTargetInstance = instances.get(dropTargetInstanceId);
  if (dropTargetInstance === undefined) {
    return;
  }
  const lastChildInstanceId = instanceSelector[droppableIndex - 1];
  const lastChildPosition = dropTargetInstance.children.findIndex(
    (child) => child.type === "id" && child.value === lastChildInstanceId
  );
  return {
    parentSelector: dropTargetSelector,
    position: lastChildPosition + 1,
  };
};

export const insertInstanceChildrenMutable = (
  data: WebstudioData,
  children: Instance["children"],
  insertTarget: DroppableTarget
) => {
  const metas = $registeredComponentMetas.get();
  insertTarget =
    getInstanceOrCreateFragmentIfNecessary(data.instances, insertTarget) ??
    insertTarget;
  insertTarget =
    wrapEditableChildrenAroundDropTargetMutable(
      data.instances,
      data.props,
      metas,
      insertTarget
    ) ?? insertTarget;
  const [parentInstanceId] = insertTarget.parentSelector;
  const parentInstance = data.instances.get(parentInstanceId);
  if (parentInstance === undefined) {
    return;
  }
  const { position } = insertTarget;
  if (position === "end") {
    parentInstance.children.push(...children);
  } else {
    parentInstance.children.splice(position, 0, ...children);
  }
};

export const insertTemplateData = (
  templateData: WebstudioFragment,
  dropTarget: DroppableTarget
) => {
  const {
    children,
    instances: insertedInstances,
    props: insertedProps,
    dataSources: insertedDataSources,
  } = templateData;
  const rootInstanceId = insertedInstances[0].id;
  updateWebstudioData((data) => {
    const {
      instances,
      dataSources,
      props,
      styleSourceSelections,
      styleSources,
      styles,
    } = data;
    for (const instance of insertedInstances) {
      instances.set(instance.id, instance);
    }
    insertInstanceChildrenMutable(data, children, dropTarget);
    insertPropsCopyMutable(props, insertedProps, new Map());
    for (const dataSource of insertedDataSources) {
      dataSources.set(dataSource.id, dataSource);
    }

    // insert only new style sources and their styles to support
    // embed template tokens which have persistent id
    // so when user changes these styles and then again add component with token
    // nothing breaks visually
    const insertedStyleSources = new Set<StyleSource["id"]>();
    for (const styleSource of templateData.styleSources) {
      if (styleSources.has(styleSource.id) === false) {
        insertedStyleSources.add(styleSource.id);
        styleSources.set(styleSource.id, styleSource);
      }
    }
    for (const styleDecl of templateData.styles) {
      if (insertedStyleSources.has(styleDecl.styleSourceId)) {
        styles.set(getStyleDeclKey(styleDecl), styleDecl);
      }
    }
    for (const styleSourceSelection of templateData.styleSourceSelections) {
      styleSourceSelections.set(
        styleSourceSelection.instanceId,
        styleSourceSelection
      );
    }
  });

  $selectedInstanceSelector.set([rootInstanceId, ...dropTarget.parentSelector]);
};

export const getComponentTemplateData = (component: string) => {
  const metas = $registeredComponentMetas.get();
  const componentMeta = metas.get(component);
  // when template not specified fallback to template with the component
  const template = componentMeta?.template ?? [
    {
      type: "instance",
      component,
      children: [],
    },
  ];
  const breakpoints = $breakpoints.get();
  const breakpointValues = Array.from(breakpoints.values());
  const baseBreakpoint = breakpointValues.find(isBaseBreakpoint);
  if (baseBreakpoint === undefined) {
    return;
  }
  return generateDataFromEmbedTemplate(template, metas, baseBreakpoint.id);
};

export const reparentInstance = (
  sourceInstanceSelector: InstanceSelector,
  dropTarget: DroppableTarget
) => {
  const [rootInstanceId] = sourceInstanceSelector;
  updateWebstudioData((data) => {
    const fragment = extractWebstudioFragment(data, rootInstanceId);
    const reparentDropTarget = getReparentDropTargetMutable(
      data.instances,
      data.props,
      $registeredComponentMetas.get(),
      sourceInstanceSelector,
      dropTarget
    );
    if (reparentDropTarget === undefined) {
      return;
    }
    deleteInstanceMutable(data, sourceInstanceSelector);
    const { newInstanceIds } = insertWebstudioFragmentCopy({
      data,
      fragment,
      availableDataSources: findAvailableDataSources(
        data.dataSources,
        data.instances,
        reparentDropTarget.parentSelector
      ),
    });
    const newRootInstanceId = newInstanceIds.get(rootInstanceId);
    if (newRootInstanceId === undefined) {
      return;
    }
    const [newParentId] = reparentDropTarget.parentSelector;
    const newParent = data.instances.get(newParentId);
    if (newParent === undefined) {
      return;
    }
    const newChild = { type: "id" as const, value: newRootInstanceId };
    if (reparentDropTarget.position === "end") {
      newParent.children.push(newChild);
    } else {
      newParent.children.splice(reparentDropTarget.position, 0, newChild);
    }
    $selectedInstanceSelector.set([
      newRootInstanceId,
      ...reparentDropTarget.parentSelector,
    ]);
  });
};

export const deleteInstanceMutable = (
  data: WebstudioData,
  instanceSelector: InstanceSelector
) => {
  // @todo tell user they can't delete root
  if (instanceSelector.length === 1) {
    return false;
  }
  if (isInstanceDetachable(data.instances, instanceSelector) === false) {
    toast.error(
      "This instance can not be moved outside of its parent component."
    );
    return false;
  }
  const {
    instances,
    props,
    styleSourceSelections,
    styleSources,
    styles,
    dataSources,
    resources,
  } = data;
  let targetInstanceId = instanceSelector[0];
  const parentInstanceId = instanceSelector[1];
  let parentInstance =
    parentInstanceId === undefined
      ? undefined
      : instances.get(parentInstanceId);
  const grandparentInstanceId = instanceSelector[2];
  const grandparentInstance = instances.get(grandparentInstanceId);

  // delete parent fragment too if its last child is going to be deleted
  // use case for slots: slot became empty and remove display: contents
  // to be displayed properly on canvas
  if (
    parentInstance?.component === "Fragment" &&
    parentInstance.children.length === 1 &&
    grandparentInstance
  ) {
    targetInstanceId = parentInstance.id;
    parentInstance = grandparentInstance;
  }

  // skip parent fake "item" instance and use grandparent collection as parent
  if (grandparentInstance?.component === collectionComponent) {
    parentInstance = grandparentInstance;
  }

  const instanceIds = findTreeInstanceIdsExcludingSlotDescendants(
    instances,
    targetInstanceId
  );
  const localStyleSourceIds = findLocalStyleSourcesWithinInstances(
    styleSources.values(),
    styleSourceSelections.values(),
    instanceIds
  );

  // may not exist when delete root
  if (parentInstance) {
    removeByMutable(
      parentInstance.children,
      (child) => child.type === "id" && child.value === targetInstanceId
    );
  }

  for (const instanceId of instanceIds) {
    instances.delete(instanceId);
  }
  // delete props, data sources and styles of deleted instance and its descendants
  for (const prop of props.values()) {
    if (instanceIds.has(prop.instanceId)) {
      props.delete(prop.id);
    }
  }
  for (const dataSource of dataSources.values()) {
    if (
      dataSource.scopeInstanceId !== undefined &&
      instanceIds.has(dataSource.scopeInstanceId)
    ) {
      dataSources.delete(dataSource.id);
      if (dataSource.type === "resource") {
        resources.delete(dataSource.resourceId);
      }
    }
  }
  for (const instanceId of instanceIds) {
    styleSourceSelections.delete(instanceId);
  }
  for (const styleSourceId of localStyleSourceIds) {
    styleSources.delete(styleSourceId);
  }
  for (const [styleDeclKey, styleDecl] of styles) {
    if (localStyleSourceIds.has(styleDecl.styleSourceId)) {
      styles.delete(styleDeclKey);
    }
  }
  return true;
};

const traverseStyleValue = (
  value: StyleValue,
  callback: (value: StyleValue) => void
) => {
  if (
    value.type === "fontFamily" ||
    value.type === "image" ||
    value.type === "unit" ||
    value.type === "keyword" ||
    value.type === "unparsed" ||
    value.type === "invalid" ||
    value.type === "unset" ||
    value.type === "rgb"
  ) {
    callback(value);
    return;
  }
  if (value.type === "var") {
    for (const item of value.fallbacks) {
      traverseStyleValue(item, callback);
    }
    return;
  }
  if (value.type === "tuple" || value.type === "layers") {
    for (const item of value.value) {
      traverseStyleValue(item, callback);
    }
    return;
  }
  value satisfies never;
};

const collectUsedDataSources = (
  expression: string,
  usedDataSourceIds: Set<DataSource["id"]>
) => {
  try {
    validateExpression(expression, {
      effectful: true,
      transformIdentifier(identifier) {
        const id = decodeDataSourceVariable(identifier);
        if (id !== undefined) {
          usedDataSourceIds.add(id);
        }
        return identifier;
      },
    });
  } catch {
    // empty block
  }
};

export const extractWebstudioFragment = (
  data: WebstudioData,
  rootInstanceId: string
): WebstudioFragment => {
  const {
    assets,
    instances,
    dataSources,
    resources,
    props,
    styleSourceSelections,
    styleSources,
    breakpoints,
    styles,
  } = data;

  // collect the instance by id and all its descendants including portal instances
  const fragmentInstanceIds = findTreeInstanceIds(instances, rootInstanceId);
  const fragmentInstances: Instance[] = [];
  const fragmentStyleSourceSelections: StyleSourceSelection[] = [];
  const fragmentStyleSources: StyleSources = new Map();
  const usedDataSourceIds = new Set<DataSource["id"]>();
  for (const instanceId of fragmentInstanceIds) {
    const instance = instances.get(instanceId);
    if (instance) {
      fragmentInstances.push(instance);
      for (const child of instance.children) {
        if (child.type === "expression") {
          collectUsedDataSources(child.value, usedDataSourceIds);
        }
      }
    }

    // collect all style sources bound to these instances
    const styleSourceSelection = styleSourceSelections.get(instanceId);
    if (styleSourceSelection) {
      fragmentStyleSourceSelections.push(styleSourceSelection);
      for (const styleSourceId of styleSourceSelection.values) {
        if (fragmentStyleSources.has(styleSourceId)) {
          continue;
        }
        const styleSource = styleSources.get(styleSourceId);
        if (styleSource === undefined) {
          continue;
        }
        fragmentStyleSources.set(styleSourceId, styleSource);
      }
    }
  }

  const fragmentAssetIds = new Set<Asset["id"]>();
  const fragmentFontFamilies = new Set<string>();

  // collect styles bound to these style sources
  const fragmentStyles: StyleDecl[] = [];
  const fragmentBreapoints: Breakpoints = new Map();
  for (const styleDecl of styles.values()) {
    if (fragmentStyleSources.has(styleDecl.styleSourceId) === false) {
      continue;
    }
    fragmentStyles.push(styleDecl);

    // collect breakpoints
    if (fragmentBreapoints.has(styleDecl.breakpointId) === false) {
      const breakpoint = breakpoints.get(styleDecl.breakpointId);
      if (breakpoint) {
        fragmentBreapoints.set(styleDecl.breakpointId, breakpoint);
      }
    }

    // collect assets including fonts
    traverseStyleValue(styleDecl.value, (value) => {
      if (value.type === "fontFamily") {
        for (const fontFamily of value.value) {
          fragmentFontFamilies.add(fontFamily);
        }
      }
      if (value.type === "image") {
        if (value.value.type === "asset") {
          fragmentAssetIds.add(value.value.value);
        }
      }
    });
  }

  // collect props bound to these instances
  const fragmentProps: Props = new Map();
  for (const prop of props.values()) {
    if (fragmentInstanceIds.has(prop.instanceId) === false) {
      continue;
    }

    fragmentProps.set(prop.id, prop);

    if (prop.type === "expression") {
      collectUsedDataSources(prop.value, usedDataSourceIds);
    }

    if (prop.type === "action") {
      for (const value of prop.value) {
        if (value.type === "execute") {
          collectUsedDataSources(value.code, usedDataSourceIds);
        }
      }
    }

    // collect assets
    if (prop.type === "asset") {
      fragmentAssetIds.add(prop.value);
    }
  }

  // collect variables scoped to fragment instances
  // or used by expressions or actions even outside of the tree
  // such variables can be bound to fragment root on paste
  const fragmentDataSources: DataSources = new Map();
  const fragmentResourceIds = new Set<Resource["id"]>();
  for (const dataSource of dataSources.values()) {
    if (
      // check if data source itself can be copied
      (dataSource.scopeInstanceId !== undefined &&
        fragmentInstanceIds.has(dataSource.scopeInstanceId)) ||
      usedDataSourceIds.has(dataSource.id)
    ) {
      fragmentDataSources.set(dataSource.id, dataSource);
      if (dataSource.type === "resource") {
        fragmentResourceIds.add(dataSource.resourceId);
      }
    }
  }

  // collect resources bound to all fragment data sources
  // and then collect data sources used in these resources
  // it creates some recursive behavior but since resources
  // cannot depend on other resources all left data sources
  // can be collected just once
  const fragmentResources: Resource[] = [];
  const dataSourceIdsUsedInResources = new Set<DataSource["id"]>();
  for (const resourceId of fragmentResourceIds) {
    const resource = resources.get(resourceId);
    if (resource === undefined) {
      continue;
    }
    fragmentResources.push(resource);
    collectUsedDataSources(resource.url, dataSourceIdsUsedInResources);
    for (const { value } of resource.headers) {
      collectUsedDataSources(value, dataSourceIdsUsedInResources);
    }
    if (resource.body) {
      collectUsedDataSources(resource.body, dataSourceIdsUsedInResources);
    }
  }
  for (const dataSource of dataSources.values()) {
    if (dataSourceIdsUsedInResources.has(dataSource.id)) {
      fragmentDataSources.set(dataSource.id, dataSource);
    }
  }

  const fragmentAssets: Asset[] = [];
  for (const asset of assets.values()) {
    if (
      fragmentAssetIds.has(asset.id) ||
      (asset.type === "font" && fragmentFontFamilies.has(asset.meta.family))
    ) {
      fragmentAssets.push(asset);
    }
  }

  return {
    children: [{ type: "id", value: rootInstanceId }],
    instances: fragmentInstances,
    styleSourceSelections: fragmentStyleSourceSelections,
    styleSources: Array.from(fragmentStyleSources.values()),
    breakpoints: Array.from(fragmentBreapoints.values()),
    styles: fragmentStyles,
    dataSources: Array.from(fragmentDataSources.values()),
    resources: fragmentResources,
    props: Array.from(fragmentProps.values()),
    assets: fragmentAssets,
  };
};

export const findAvailableDataSources = (
  dataSources: DataSources,
  instances: Instances,
  instanceSelector: InstanceSelector
) => {
  // inline data sources not scoped to current portal
  const instanceIds = new Set();
  for (const instanceId of instanceSelector) {
    const instance = instances.get(instanceId);
    if (instance?.component === portalComponent) {
      break;
    }
    instanceIds.add(instanceId);
  }
  const availableDataSources = new Set<DataSource["id"]>();
  for (const { id, scopeInstanceId } of dataSources.values()) {
    if (scopeInstanceId && instanceIds.has(scopeInstanceId)) {
      availableDataSources.add(id);
    }
  }
  return availableDataSources;
};

const inlineUnavailableDataSources = ({
  code,
  availableDataSources,
  dataSources,
}: {
  code: string;
  availableDataSources: Set<DataSource["id"]>;
  dataSources: DataSources;
}) => {
  let isDiscarded = false;
  const newCode = validateExpression(code, {
    effectful: true,
    transformIdentifier: (identifier, assignee) => {
      const dataSourceId = decodeDataSourceVariable(identifier);
      if (
        dataSourceId === undefined ||
        availableDataSources.has(dataSourceId)
      ) {
        return identifier;
      }
      // left operand of assign operator cannot be inlined
      if (assignee) {
        isDiscarded = true;
      }
      const dataSource = dataSources.get(dataSourceId);
      // inline variable not scoped to portal content instances
      if (dataSource?.type === "variable") {
        return JSON.stringify(dataSource.value.value);
      }
      return "{}";
    },
  });
  return { code: newCode, isDiscarded };
};

const replaceDataSources = (
  code: string,
  replacements: Map<DataSource["id"], DataSource["id"]>
) => {
  return validateExpression(code, {
    effectful: true,
    transformIdentifier: (identifier) => {
      const dataSourceId = decodeDataSourceVariable(identifier);
      if (dataSourceId === undefined) {
        return identifier;
      }
      return encodeDataSourceVariable(
        replacements.get(dataSourceId) ?? dataSourceId
      );
    },
  });
};

export const insertWebstudioFragmentCopy = ({
  data,
  fragment,
  availableDataSources,
}: {
  data: WebstudioData;
  fragment: WebstudioFragment;
  availableDataSources: Set<DataSource["id"]>;
}) => {
  const newInstanceIds = new Map<Instance["id"], Instance["id"]>();
  const newDataSourceIds = new Map<DataSource["id"], DataSource["id"]>();
  const newDataIds = {
    newInstanceIds,
    newDataSourceIds,
  };
  const projectId = $project.get()?.id;
  if (projectId === undefined) {
    return newDataIds;
  }

  const fragmentInstances: Instances = new Map();
  const portalContentIds = new Set<Instance["id"]>();
  for (const instance of fragment.instances) {
    fragmentInstances.set(instance.id, instance);
    if (instance.component === portalComponent) {
      for (const child of instance.children) {
        if (child.type === "id") {
          portalContentIds.add(child.value);
        }
      }
    }
  }

  const fragmentDataSources: DataSources = new Map();
  for (const dataSource of fragment.dataSources) {
    fragmentDataSources.set(dataSource.id, dataSource);
  }

  const {
    assets,
    instances,
    resources,
    dataSources,
    props,
    breakpoints,
    styleSources,
    styles,
    styleSourceSelections,
  } = data;

  /**
   * insert reusables without changing their ids to not bloat data
   * and catch up with user changes
   * - assets
   * - breakpoints
   * - token styles
   * - portals
   *
   * breakpoints behave slightly differently and merged with existing ones
   * and those ids are used instead
   */

  // insert assets

  for (const asset of fragment.assets) {
    // asset can be already present if pasting to the same project
    if (assets.has(asset.id) === false) {
      // we use the same asset.id so the references are preserved
      assets.set(asset.id, { ...asset, projectId });
    }
  }

  // merge breakpoints

  const mergedBreakpointIds = new Map<Breakpoint["id"], Breakpoint["id"]>();
  for (const newBreakpoint of fragment.breakpoints) {
    let matched = false;
    for (const breakpoint of breakpoints.values()) {
      if (equalMedia(breakpoint, newBreakpoint)) {
        matched = true;
        mergedBreakpointIds.set(newBreakpoint.id, breakpoint.id);
        break;
      }
    }
    if (matched === false) {
      breakpoints.set(newBreakpoint.id, newBreakpoint);
    }
  }

  // insert tokens with their styles

  const tokenStyleSourceIds = new Set<StyleSource["id"]>();
  for (const styleSource of fragment.styleSources) {
    // prevent inserting styles when token is already present
    if (styleSource.type === "local" || styleSources.has(styleSource.id)) {
      continue;
    }
    styleSource.type satisfies "token";
    tokenStyleSourceIds.add(styleSource.id);
    styleSources.set(styleSource.id, styleSource);
  }
  for (const styleDecl of fragment.styles) {
    if (tokenStyleSourceIds.has(styleDecl.styleSourceId)) {
      const { breakpointId } = styleDecl;
      const newStyleDecl: StyleDecl = {
        ...styleDecl,
        breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
      };
      styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
    }
  }

  // insert portal contents
  // - instances
  // - data sources
  // - props
  // - local styles
  for (const rootInstanceId of portalContentIds) {
    // prevent reinserting portals which could be already changed by user
    if (instances.has(rootInstanceId)) {
      continue;
    }

    const instanceIds = findTreeInstanceIdsExcludingSlotDescendants(
      fragmentInstances,
      rootInstanceId
    );

    const availablePortalDataSources = new Set(availableDataSources);
    const usedResourceIds = new Set<Resource["id"]>();
    for (const dataSource of fragment.dataSources) {
      // insert only data sources within portal content
      if (
        dataSource.scopeInstanceId &&
        instanceIds.has(dataSource.scopeInstanceId)
      ) {
        availablePortalDataSources.add(dataSource.id);
        dataSources.set(dataSource.id, dataSource);
        if (dataSource.type === "resource") {
          usedResourceIds.add(dataSource.resourceId);
        }
      }
    }

    for (const resource of fragment.resources) {
      if (usedResourceIds.has(resource.id) === false) {
        continue;
      }
      const newUrl = inlineUnavailableDataSources({
        code: resource.url,
        availableDataSources: availablePortalDataSources,
        dataSources: fragmentDataSources,
      }).code;
      const newHeaders = resource.headers.map((header) => ({
        name: header.name,
        value: inlineUnavailableDataSources({
          code: header.value,
          availableDataSources: availablePortalDataSources,
          dataSources: fragmentDataSources,
        }).code,
      }));
      const newBody =
        resource.body === undefined
          ? undefined
          : inlineUnavailableDataSources({
              code: resource.body,
              availableDataSources: availablePortalDataSources,
              dataSources: fragmentDataSources,
            }).code;
      resources.set(resource.id, {
        ...resource,
        url: newUrl,
        headers: newHeaders,
        body: newBody,
      });
    }

    for (const instance of fragment.instances) {
      if (instanceIds.has(instance.id)) {
        instances.set(instance.id, {
          ...instance,
          children: instance.children.map((child) => {
            if (child.type === "expression") {
              const { code } = inlineUnavailableDataSources({
                code: child.value,
                availableDataSources: availablePortalDataSources,
                dataSources: fragmentDataSources,
              });
              return {
                type: "expression",
                value: code,
              };
            }
            return child;
          }),
        });
      }
    }

    for (let prop of fragment.props) {
      if (instanceIds.has(prop.instanceId) === false) {
        continue;
      }
      // inline data sources not available in scope into expressions
      if (prop.type === "expression") {
        const { code } = inlineUnavailableDataSources({
          code: prop.value,
          availableDataSources: availablePortalDataSources,
          dataSources: fragmentDataSources,
        });
        prop = { ...prop, value: code };
      }
      if (prop.type === "action") {
        prop = {
          ...prop,
          value: prop.value.flatMap((value) => {
            if (value.type !== "execute") {
              return [value];
            }
            const { code, isDiscarded } = inlineUnavailableDataSources({
              code: value.code,
              availableDataSources: availablePortalDataSources,
              dataSources: fragmentDataSources,
            });
            if (isDiscarded) {
              return [];
            }
            return [{ ...value, code }];
          }),
        };
      }
      props.set(prop.id, prop);
    }

    // insert local style sources with their styles

    const instanceStyleSourceIds = new Set<StyleSource["id"]>();
    for (const styleSourceSelection of fragment.styleSourceSelections) {
      const { instanceId } = styleSourceSelection;
      if (instanceIds.has(instanceId) === false) {
        continue;
      }
      styleSourceSelections.set(instanceId, styleSourceSelection);
      for (const styleSourceId of styleSourceSelection.values) {
        instanceStyleSourceIds.add(styleSourceId);
      }
    }
    const localStyleSourceIds = new Set<StyleSource["id"]>();
    for (const styleSource of fragment.styleSources) {
      if (
        styleSource.type === "local" &&
        instanceStyleSourceIds.has(styleSource.id)
      ) {
        localStyleSourceIds.add(styleSource.id);
        styleSources.set(styleSource.id, styleSource);
      }
    }
    for (const styleDecl of fragment.styles) {
      if (localStyleSourceIds.has(styleDecl.styleSourceId)) {
        const { breakpointId } = styleDecl;
        const newStyleDecl: StyleDecl = {
          ...styleDecl,
          breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
        };
        styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
      }
    }
  }

  /**
   * inserting unique content is structurally similar to inserting portal content
   * but all ids are regenerated to support duplicating existing content
   * - instances
   * - data sources
   * - props
   * - local styles
   */

  // generate new ids only instances outside of portals
  const fragmentInstanceIds = findTreeInstanceIdsExcludingSlotDescendants(
    fragmentInstances,
    fragment.instances[0].id
  );
  for (const instanceId of fragmentInstanceIds) {
    newInstanceIds.set(instanceId, nanoid());
  }

  const availableFragmentDataSources = new Set(availableDataSources);
  const newResourceIds = new Map<Resource["id"], Resource["id"]>();
  const usedResourceIds = new Set<Resource["id"]>();
  for (const dataSource of fragment.dataSources) {
    const { scopeInstanceId } = dataSource;
    // insert only data sources within portal content
    if (scopeInstanceId && fragmentInstanceIds.has(scopeInstanceId)) {
      availableFragmentDataSources.add(dataSource.id);
      const newDataSourceId = nanoid();
      newDataSourceIds.set(dataSource.id, newDataSourceId);
      if (dataSource.type === "resource") {
        const newResourceId = nanoid();
        newResourceIds.set(dataSource.resourceId, newResourceId);
        usedResourceIds.add(dataSource.resourceId);
        dataSources.set(newDataSourceId, {
          ...dataSource,
          id: newDataSourceId,
          scopeInstanceId: newInstanceIds.get(scopeInstanceId),
          resourceId: newResourceId,
        });
      } else {
        dataSources.set(newDataSourceId, {
          ...dataSource,
          id: newDataSourceId,
          scopeInstanceId: newInstanceIds.get(scopeInstanceId),
        });
      }
    }
  }

  for (const resource of fragment.resources) {
    if (usedResourceIds.has(resource.id) === false) {
      continue;
    }
    const newResourceId = newResourceIds.get(resource.id) ?? resource.id;

    const newUrl = replaceDataSources(
      inlineUnavailableDataSources({
        code: resource.url,
        availableDataSources: availableFragmentDataSources,
        dataSources: fragmentDataSources,
      }).code,
      newDataSourceIds
    );
    const newHeaders = resource.headers.map((header) => ({
      name: header.name,
      value: replaceDataSources(
        inlineUnavailableDataSources({
          code: header.value,
          availableDataSources: availableFragmentDataSources,
          dataSources: fragmentDataSources,
        }).code,
        newDataSourceIds
      ),
    }));
    const newBody =
      resource.body === undefined
        ? undefined
        : replaceDataSources(
            inlineUnavailableDataSources({
              code: resource.body,
              availableDataSources: availableFragmentDataSources,
              dataSources: fragmentDataSources,
            }).code,
            newDataSourceIds
          );
    resources.set(newResourceId, {
      ...resource,
      id: newResourceId,
      url: newUrl,
      headers: newHeaders,
      body: newBody,
    });
  }

  for (const instance of fragment.instances) {
    if (fragmentInstanceIds.has(instance.id)) {
      const newId = newInstanceIds.get(instance.id) ?? instance.id;
      instances.set(newId, {
        ...instance,
        id: newId,
        children: instance.children.map((child) => {
          if (child.type === "id") {
            return {
              type: "id",
              value: newInstanceIds.get(child.value) ?? child.value,
            };
          }
          if (child.type === "expression") {
            const { code } = inlineUnavailableDataSources({
              code: child.value,
              availableDataSources: availableFragmentDataSources,
              dataSources: fragmentDataSources,
            });
            return {
              type: "expression",
              value: replaceDataSources(code, newDataSourceIds),
            };
          }
          return child;
        }),
      });
    }
  }

  for (let prop of fragment.props) {
    if (fragmentInstanceIds.has(prop.instanceId) === false) {
      continue;
    }
    // inline data sources not available in scope into expressions
    if (prop.type === "expression") {
      const { code } = inlineUnavailableDataSources({
        code: prop.value,
        availableDataSources: availableFragmentDataSources,
        dataSources: fragmentDataSources,
      });
      prop = { ...prop, value: replaceDataSources(code, newDataSourceIds) };
    }
    if (prop.type === "action") {
      prop = {
        ...prop,
        value: prop.value.flatMap((value) => {
          if (value.type !== "execute") {
            return [value];
          }
          const { code, isDiscarded } = inlineUnavailableDataSources({
            code: value.code,
            availableDataSources: availableFragmentDataSources,
            dataSources: fragmentDataSources,
          });
          if (isDiscarded) {
            return [];
          }
          return [
            { ...value, code: replaceDataSources(code, newDataSourceIds) },
          ];
        }),
      };
    }
    if (prop.type === "parameter") {
      prop = {
        ...prop,
        value: newDataSourceIds.get(prop.value) ?? prop.value,
      };
    }
    const newId = nanoid();
    props.set(newId, {
      ...prop,
      id: newId,
      instanceId: newInstanceIds.get(prop.instanceId) ?? prop.instanceId,
    });
  }

  // insert local styles with new ids

  const instanceStyleSourceIds = new Set<StyleSource["id"]>();
  for (const styleSourceSelection of fragment.styleSourceSelections) {
    if (fragmentInstanceIds.has(styleSourceSelection.instanceId) === false) {
      continue;
    }
    for (const styleSourceId of styleSourceSelection.values) {
      instanceStyleSourceIds.add(styleSourceId);
    }
  }
  const newLocalStyleSourceIds = new Map<
    StyleSource["id"],
    StyleSource["id"]
  >();
  for (const styleSource of fragment.styleSources) {
    if (
      styleSource.type === "local" &&
      instanceStyleSourceIds.has(styleSource.id)
    ) {
      const newId = nanoid();
      newLocalStyleSourceIds.set(styleSource.id, newId);
      styleSources.set(newId, { ...styleSource, id: newId });
    }
  }
  for (const styleSourceSelection of fragment.styleSourceSelections) {
    const { instanceId, values } = styleSourceSelection;
    if (fragmentInstanceIds.has(instanceId) === false) {
      continue;
    }
    const newInstanceId = newInstanceIds.get(instanceId) ?? instanceId;
    styleSourceSelections.set(newInstanceId, {
      instanceId: newInstanceId,
      values: values.map(
        (styleSourceId) =>
          newLocalStyleSourceIds.get(styleSourceId) ?? styleSourceId
      ),
    });
    for (const styleSourceId of styleSourceSelection.values) {
      instanceStyleSourceIds.add(styleSourceId);
    }
  }
  for (const styleDecl of fragment.styles) {
    const { breakpointId, styleSourceId } = styleDecl;
    if (newLocalStyleSourceIds.has(styleDecl.styleSourceId)) {
      const newStyleDecl: StyleDecl = {
        ...styleDecl,
        styleSourceId:
          newLocalStyleSourceIds.get(styleSourceId) ?? styleSourceId,
        breakpointId: mergedBreakpointIds.get(breakpointId) ?? breakpointId,
      };
      styles.set(getStyleDeclKey(newStyleDecl), newStyleDecl);
    }
  }

  return newDataIds;
};

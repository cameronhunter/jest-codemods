import { JEST_MATCHER_TO_MAX_ARGS, JEST_MOCK_PROPERTIES } from '../utils/consts';
import detectQuoteStyle from '../utils/quote-style';
import { getRequireOrImportName, removeRequireAndImport } from '../utils/imports';
import updateJestImports from '../utils/jest-imports';
import {
    findParentCallExpression,
    findParentVariableDeclaration,
} from '../utils/recast-helpers';
import logger from '../utils/logger';
import proxyquireTransformer from '../utils/proxyquire';

const matcherRenaming = {
    toExist: 'toBeTruthy',
    toNotExist: 'toBeFalsy',
    toNotBe: 'not.toBe',
    toNotEqual: 'not.toEqual',
    toNotThrow: 'not.toThrow',
    toBeA: 'toBeInstanceOf',
    toBeAn: 'toBeInstanceOf',
    toNotBeA: 'not.toBeInstanceOf',
    toNotBeAn: 'not.toBeInstanceOf',
    toNotMatch: 'not.toMatch',
    toBeFewerThan: 'toBeLessThan',
    toBeLessThanOrEqualTo: 'toBeLessThanOrEqual',
    toBeMoreThan: 'toBeGreaterThan',
    toBeGreaterThanOrEqualTo: 'toBeGreaterThanOrEqual',
    toInclude: 'toContain',
    toExclude: 'not.toContain',
    toNotContain: 'not.toContain',
    toNotInclude: 'not.toContain',
    toNotHaveBeenCalled: 'not.toHaveBeenCalled',
};

const matchersToBe = new Set(['toBeA', 'toBeAn', 'toNotBeA', 'toNotBeAn']);

const matchersWithKey = new Set([
    'toContainKey',
    'toExcludeKey',
    'toIncludeKey',
    'toNotContainKey',
    'toNotIncludeKey',
]);

const matchersWithKeys = new Set([
    'toContainKeys',
    'toExcludeKeys',
    'toIncludeKeys',
    'toNotContainKeys',
    'toNotIncludeKeys',
]);

const expectSpyFunctions = new Set(['createSpy', 'spyOn', 'isSpy', 'restoreSpies']);
const unsupportedSpyFunctions = new Set(['isSpy', 'restoreSpies']);

export default function expectTransformer(fileInfo, api, options) {
    const j = api.jscodeshift;
    const ast = j(fileInfo.source);
    const { standaloneMode } = options;

    const expectFunctionName = getRequireOrImportName(j, ast, 'expect');

    if (!expectFunctionName) {
        // No expect require/import were found
        return fileInfo.source;
    }

    if (!standaloneMode) {
        removeRequireAndImport(j, ast, 'expect');
    }

    const logWarning = (msg, node) => logger(fileInfo, msg, node);

    function balanceMatcherNodeArguments(matcherNode, matcher, path) {
        const newJestMatcherName = matcher.name.replace('not.', '');
        const maxArgs = JEST_MATCHER_TO_MAX_ARGS[newJestMatcherName];
        if (typeof maxArgs === 'undefined') {
            throw new Error(
                `Unknown matcher "${newJestMatcherName}" (JEST_MATCHER_TO_MAX_ARGS)`
            );
        }

        if (matcherNode.arguments.length > maxArgs) {
            // Try to remove assertion message
            const lastArg = matcherNode.arguments[matcherNode.arguments.length - 1];
            if (lastArg.type === 'Literal') {
                matcherNode.arguments.pop();
            }
        }

        if (matcherNode.arguments.length <= maxArgs) {
            return;
        }

        logWarning(
            `Too many arguments given to "${newJestMatcherName}". Expected max ${maxArgs} but got ${matcherNode.arguments.length}`,
            path
        );
    }

    const updateMatchers = () =>
        ast
            .find(j.MemberExpression, {
                object: {
                    type: 'CallExpression',
                    callee: { type: 'Identifier', name: expectFunctionName },
                },
                property: { type: 'Identifier' },
            })
            .forEach(path => {
                if (path.parentPath.parentPath.node.type === 'MemberExpression') {
                    logWarning(
                        'Chaining expect matchers is currently not supported',
                        path
                    );
                    return;
                }

                if (!standaloneMode) {
                    path.parentPath.node.callee.object.callee.name = 'expect';
                }

                const matcherNode = path.parentPath.node;
                const matcher = path.node.property;
                const matcherName = matcher.name;

                const matcherArgs = matcherNode.arguments;
                const expectArgs = path.node.object.arguments;

                const isNot =
                    matcherName.indexOf('Not') !== -1 ||
                    matcherName.indexOf('Exclude') !== -1;

                if (matcherRenaming[matcherName]) {
                    matcher.name = matcherRenaming[matcherName];
                }

                if (matchersToBe.has(matcherName)) {
                    if (matcherArgs[0].type === 'Literal') {
                        expectArgs[0] = j.unaryExpression('typeof', expectArgs[0]);
                        matcher.name = isNot ? 'not.toBe' : 'toBe';
                    }
                }

                if (matchersWithKey.has(matcherName)) {
                    expectArgs[0] = j.template.expression`Object.keys(${expectArgs[0]})`;
                    matcher.name = isNot ? 'not.toContain' : 'toContain';
                }

                if (matchersWithKeys.has(matcherName)) {
                    const keys = matcherArgs[0];
                    matcherArgs[0] = j.identifier('e');
                    matcher.name = isNot ? 'not.toContain' : 'toContain';
                    j(path.parentPath).replaceWith(
                        j.template.expression`\
${keys}.forEach(e => {
  ${matcherNode}
})`
                    );
                }

                if (matcherName === 'toMatch' || matcherName === 'toNotMatch') {
                    const arg = matcherArgs[0];
                    if (arg.type === 'ObjectExpression') {
                        matcher.name = isNot ? 'not.toMatchObject' : 'toMatchObject';
                    }
                }

                balanceMatcherNodeArguments(matcherNode, matcher, path);
            });

    const updateSpies = () => {
        ast
            .find(j.CallExpression, {
                callee: {
                    type: 'Identifier',
                    name: name => expectSpyFunctions.has(name),
                },
            })
            .forEach(path => {
                logWarning(
                    `"${path.value.callee.name}" is currently not supported ` +
                        `(use "expect.${path.value.callee.name}" instead for transformation to work)`,
                    path
                );
            });

        // Update expect.createSpy calls and warn about restoreSpies
        ast
            .find(j.MemberExpression, {
                object: {
                    type: 'Identifier',
                    name: expectFunctionName,
                },
                property: { type: 'Identifier' },
            })
            .forEach(path => {
                const { name } = path.value.property;
                if (name === 'createSpy') {
                    path.value.property.name = 'fn';
                }

                if (unsupportedSpyFunctions.has(name)) {
                    logWarning(
                        `"${path.value.property.name}" is currently not supported`,
                        path
                    );
                }
            });

        // Update mock chain calls
        const updateSpyProperty = (path, property) => {
            if (!property) {
                return;
            }

            if (property.name === 'andReturn') {
                const callExpression = findParentCallExpression(path, property.name)
                    .value;
                callExpression.arguments = [
                    j.arrowFunctionExpression(
                        [j.identifier('()')],
                        callExpression.arguments[0]
                    ),
                ];
            }

            if (property.name === 'andThrow') {
                const callExpression = findParentCallExpression(path, property.name)
                    .value;
                const throughExpression = callExpression.arguments[0];
                callExpression.arguments = [
                    j.arrowFunctionExpression(
                        [j.identifier('()')],
                        j.blockStatement([j.throwStatement(throughExpression)])
                    ),
                ];
            }

            if (property.name === 'andCallThrough') {
                logWarning(`"${property.name}" is currently not supported`, path);
            }

            const propertyNameMap = {
                andCall: 'mockImplementation',
                andReturn: 'mockImplementation',
                andThrow: 'mockImplementation',
                calls: 'mock.calls',
                reset: 'mockClear',
                restore: 'mockReset',
            };

            const newPropertyName = propertyNameMap[property.name];
            if (newPropertyName) {
                property.name = newPropertyName;
            }

            // Remap mock.calls[x].arguments[y] to mock.calls[x][y]
            const potentialArgumentsNode = path.parentPath.parentPath.value;
            if (
                property.name === 'mock.calls' &&
                potentialArgumentsNode.property &&
                potentialArgumentsNode.property.name === 'arguments'
            ) {
                const outherNode = path.parentPath.parentPath.parentPath;

                const variableName = path.value.object.name;
                const callsArg = path.parentPath.value.property.name;
                const argumentsArg = outherNode.value.property.name;

                outherNode.replace(
                    j.memberExpression(
                        j.memberExpression(
                            j.memberExpression(
                                j.identifier(variableName),
                                j.identifier('mock.calls')
                            ),
                            j.identifier(callsArg),
                            true
                        ),
                        j.identifier(argumentsArg),
                        true
                    )
                );
            }
        };

        const spyVariables = [];
        ast
            .find(j.MemberExpression, {
                object: {
                    type: 'Identifier',
                    name: expectFunctionName,
                },
                property: {
                    type: 'Identifier',
                    name: name => JEST_MOCK_PROPERTIES.has(name),
                },
            })
            .forEach(path => {
                const spyVariable = findParentVariableDeclaration(path);
                if (spyVariable) {
                    spyVariables.push(spyVariable.value.id.name);
                }

                const { property } = path.parentPath.parentPath.value;

                updateSpyProperty(path, property);
            });

        // Update spy variable methods
        ast
            .find(j.MemberExpression, {
                object: {
                    type: 'Identifier',
                    name: name => spyVariables.indexOf(name) >= 0,
                },
                property: { type: 'Identifier' },
            })
            .forEach(path => {
                const { property } = path.value;
                updateSpyProperty(path, property);
            });
    };

    updateMatchers();
    updateSpies();
    updateJestImports(j, ast, standaloneMode, expectFunctionName);
    proxyquireTransformer(fileInfo, j, ast);

    const quote = detectQuoteStyle(j, ast) || 'single';
    return ast.toSource({ quote });
}
